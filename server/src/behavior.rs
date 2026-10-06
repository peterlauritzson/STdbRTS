//! Unit behaviors: small finite-state policies the server runs for a unit so it
//! can react to the fight without paying the command delay on every decision.
//!
//! A player gives a "meta command" (Harass, Guard or Raid here) through the
//! ordinary `issue_order` path; once it activates, the unit carries a
//! [`Behavior`] and the simulation re-evaluates it every
//! [`BEHAVIOR_INTERVAL_TICKS`]. See `docs/honeybadger/COMMANDS-AND-BEHAVIORS.md`,
//! "Behavior contract".
//!
//! The three presets are **data**, not three hand-written state machines: one
//! small interpreter ([`next_state`]) runs any [`Policy`], and the presets are
//! static tables of [`State`]s and [`Transition`]s. Player-authored policies
//! later reuse exactly this model and the same bounds ([`validate_policy`]), so
//! nothing here may grow a preset-specific branch.
//!
//! What a policy may do is deliberately narrow. An [`Action`] only ever sets the
//! unit's ordinary order (`attack_move`, `move`, `hold`), so movement, combat
//! and their costs stay the ordinary code's; a [`Condition`] only reads the
//! unit's own vitals, its anchors, the time in the state and radius-bounded
//! local counts (at most [`MAX_QUERY_RADIUS`]). There is no fog of war yet, so
//! every unit inside such a radius is legitimately visible.

use crate::simulation::Order;

/// How often, in ticks, a behavior is evaluated. Every unit under a behavior is
/// evaluated on the same tick, so the work is one bounded pass every quarter
/// second rather than a pass every tick.
pub const BEHAVIOR_INTERVAL_TICKS: u64 = 5;
/// The least time a state is held before any transition may leave it: the
/// hysteresis that stops a unit flickering between "fight" and "retreat" on a
/// health bar hovering at the threshold.
pub const MIN_DWELL_TICKS: u64 = 20;
/// The widest radius any condition may ask about. Keeps every query local and
/// its cost bounded by the spatial index, whatever a policy asks for.
pub const MAX_QUERY_RADIUS: f32 = 600.0;
/// Engineering trial limits from the behavior contract, not gameplay caps.
pub const MAX_STATES: usize = 8;
pub const MAX_TRANSITIONS: usize = 4;
pub const MAX_CONDITIONS: usize = 2;

/// A point a behavior is defined relative to, resolved against the unit's
/// [`Behavior`] rather than stored in the policy, so one policy serves every
/// goal a player clicks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    /// Where the player pointed when giving the order.
    Goal,
    /// The owner's nearest completed hub when the behavior activated.
    Home,
}

/// What a state has the unit do. Each one is an ordinary order, so a policy can
/// never move, shoot or heal outside what the unit could be told to do anyway.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    AttackMove(Anchor),
    Move(Anchor),
    Hold,
}

/// One fact a transition may test.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Condition {
    /// Hit points plus shields below this percentage of their maxima.
    HealthBelow(u8),
    /// Hit points plus shields at or above this percentage of their maxima.
    HealthAtLeast(u8),
    /// More armed enemies than armed friends (self included) within `radius`.
    /// See [`Senses::outnumbered`].
    Outnumbered { radius: f32 },
    /// No enemy entity at all within the radius.
    NoEnemyWithin(f32),
    /// Within this distance of the anchor.
    Near(Anchor, f32),
    /// Further than this distance from the anchor.
    FartherThan(Anchor, f32),
    /// The current state has been held at least this many ticks.
    DwellAtLeast(u64),
}

/// Leave for state `to` when every condition in `when` holds (an empty `when`
/// always holds, subject to the minimum dwell).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub when: &'static [Condition],
    pub to: u8,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State {
    /// Shown to players beside the preset ("Harass · retreat").
    pub name: &'static str,
    pub action: Action,
    /// Tried in order; the first whose conditions all hold wins.
    pub transitions: &'static [Transition],
}

/// A whole behavior. State 0 is the initial state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Policy {
    /// The order kind that activates it, and its persisted id.
    pub name: &'static str,
    pub states: &'static [State],
    /// While attack-moving, pick enemy labour within reach over any other
    /// target. A harasser is there for the economy, not the army.
    pub prefers_labour: bool,
}

/// A unit's running behavior. Persisted beside the rest of the server-only unit
/// state, so a behavior survives the database round trip every tick and a
/// player's disconnection.
#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Behavior {
    /// The [`Policy::name`] it runs.
    pub preset: String,
    pub goal_x: f32,
    pub goal_y: f32,
    pub home_x: f32,
    pub home_y: f32,
    /// Index into the policy's states.
    pub state: u8,
    /// The tick the current state was entered, for the dwell.
    pub entered_tick: u64,
}

impl Behavior {
    /// Where an anchor is, for this unit's behavior.
    pub fn anchor(&self, anchor: Anchor) -> (f32, f32) {
        match anchor {
            Anchor::Goal => (self.goal_x, self.goal_y),
            Anchor::Home => (self.home_x, self.home_y),
        }
    }

    /// The order a state's action stands for.
    pub fn order_for(&self, action: Action) -> Order {
        let (kind, (x, y)) = match action {
            Action::AttackMove(anchor) => ("attack_move", self.anchor(anchor)),
            Action::Move(anchor) => ("move", self.anchor(anchor)),
            Action::Hold => ("hold", (0.0, 0.0)),
        };
        Order {
            kind: kind.into(),
            x,
            y,
            target: 0,
        }
    }

    /// The running state's definition, if the policy still exists and the index
    /// is still in it.
    pub fn current(&self) -> Option<&'static State> {
        policy(&self.preset)?.states.get(self.state as usize)
    }
}

/// The facts a policy can read about the unit it runs on. The simulation answers
/// these from the start-of-tick snapshot; tests can answer them directly.
pub trait Senses {
    /// `(hp + shields, max_hp + max_shields)`.
    fn health(&self) -> (i32, i32);
    fn position(&self) -> (f32, f32);
    /// Armed enemy mobile units and finished enemy static defenses within
    /// `radius` outnumber the unit's own armed mobile units there, itself
    /// counted whether or not it is armed.
    fn outnumbered(&self, radius: f32) -> bool;
    fn enemy_within(&self, radius: f32) -> bool;
}

const HARASS: Policy = Policy {
    name: "harass",
    prefers_labour: true,
    states: &[
        State {
            name: "advance",
            action: Action::AttackMove(Anchor::Goal),
            transitions: &[
                Transition { when: &[Condition::HealthBelow(50)], to: 1 },
                Transition { when: &[Condition::Outnumbered { radius: 350.0 }], to: 1 },
            ],
        },
        State {
            name: "retreat",
            action: Action::Move(Anchor::Home),
            transitions: &[Transition { when: &[Condition::Near(Anchor::Home, 250.0)], to: 2 }],
        },
        // A unit that cannot heal stays here as a home defender. Intended: it
        // is too hurt to harass and still useful at home.
        State {
            name: "recover",
            action: Action::Hold,
            transitions: &[Transition { when: &[Condition::HealthAtLeast(80)], to: 0 }],
        },
    ],
};

const GUARD: Policy = Policy {
    name: "guard",
    prefers_labour: false,
    states: &[
        State {
            name: "return",
            action: Action::Move(Anchor::Goal),
            transitions: &[Transition { when: &[Condition::Near(Anchor::Goal, 150.0)], to: 1 }],
        },
        // The leash: dragged too far by a chase, it walks back without
        // fighting rather than following a kite across the map.
        State {
            name: "watch",
            action: Action::AttackMove(Anchor::Goal),
            transitions: &[Transition {
                when: &[Condition::FartherThan(Anchor::Goal, 600.0)],
                to: 0,
            }],
        },
    ],
};

const RAID: Policy = Policy {
    name: "raid",
    prefers_labour: false,
    states: &[
        State {
            name: "advance",
            action: Action::AttackMove(Anchor::Goal),
            transitions: &[Transition { when: &[Condition::HealthBelow(35)], to: 1 }],
        },
        State {
            name: "retreat",
            action: Action::Move(Anchor::Home),
            transitions: &[Transition { when: &[Condition::Near(Anchor::Home, 250.0)], to: 2 }],
        },
        State {
            name: "recover",
            action: Action::Hold,
            transitions: &[Transition { when: &[Condition::HealthAtLeast(90)], to: 0 }],
        },
    ],
};

/// Every preset, in the order a client lists them.
pub const PRESETS: [&Policy; 3] = [&HARASS, &GUARD, &RAID];

/// The preset an order kind activates, or `None` for an ordinary order.
pub fn policy(name: &str) -> Option<&'static Policy> {
    PRESETS.into_iter().find(|policy| policy.name == name)
}

/// The two labels the public `unit` row carries: the preset and the state
/// name, both `None` for a unit with no behavior.
pub fn labels(behavior: Option<&Behavior>) -> (Option<String>, Option<String>) {
    match behavior {
        Some(behavior) => (
            Some(behavior.preset.clone()),
            behavior.current().map(|state| state.name.to_string()),
        ),
        None => (None, None),
    }
}

/// Checks a policy against the trial limits: state, transition and condition
/// counts, transition targets inside the policy, percentages that are
/// percentages, and query radii within [`MAX_QUERY_RADIUS`]. The presets are
/// checked by a test; an authored policy will be checked here on submission.
pub fn validate_policy(policy: &Policy) -> Result<(), String> {
    if policy.states.is_empty() || policy.states.len() > MAX_STATES {
        return Err(format!("A policy has 1 to {MAX_STATES} states"));
    }
    for state in policy.states {
        if state.transitions.len() > MAX_TRANSITIONS {
            return Err(format!("A state has at most {MAX_TRANSITIONS} transitions"));
        }
        for transition in state.transitions {
            if transition.when.len() > MAX_CONDITIONS {
                return Err(format!("A transition tests at most {MAX_CONDITIONS} conditions"));
            }
            if transition.to as usize >= policy.states.len() {
                return Err("A transition leads to a state that does not exist".into());
            }
            for condition in transition.when {
                let radius = match *condition {
                    Condition::HealthBelow(percent) | Condition::HealthAtLeast(percent) => {
                        if percent > 100 {
                            return Err("A health threshold is a percentage".into());
                        }
                        continue;
                    }
                    Condition::Outnumbered { radius } | Condition::NoEnemyWithin(radius) => radius,
                    Condition::Near(_, reach) | Condition::FartherThan(_, reach) => {
                        if !reach.is_finite() || reach < 0.0 {
                            return Err("A distance must be a finite, non-negative number".into());
                        }
                        continue;
                    }
                    Condition::DwellAtLeast(_) => continue,
                };
                if !radius.is_finite() || radius <= 0.0 || radius > MAX_QUERY_RADIUS {
                    return Err(format!("A query radius is above 0 and at most {MAX_QUERY_RADIUS}"));
                }
            }
        }
    }
    Ok(())
}

fn holds(condition: Condition, behavior: &Behavior, tick: u64, senses: &impl Senses) -> bool {
    let (x, y) = senses.position();
    let away = |anchor| {
        let (anchor_x, anchor_y) = behavior.anchor(anchor);
        crate::distance(x, y, anchor_x, anchor_y)
    };
    // Integer percentages, compared by cross-multiplying so no rounding decides
    // which side of a threshold a unit is on. A kind with no health pool at all
    // reads as full.
    let percent_below = |percent: u8| {
        let (current, maximum) = senses.health();
        maximum > 0 && (current as i64) * 100 < percent as i64 * maximum as i64
    };
    match condition {
        Condition::HealthBelow(percent) => percent_below(percent),
        Condition::HealthAtLeast(percent) => !percent_below(percent),
        Condition::Outnumbered { radius } => senses.outnumbered(radius.min(MAX_QUERY_RADIUS)),
        Condition::NoEnemyWithin(radius) => !senses.enemy_within(radius.min(MAX_QUERY_RADIUS)),
        Condition::Near(anchor, reach) => away(anchor) <= reach,
        Condition::FartherThan(anchor, reach) => away(anchor) > reach,
        Condition::DwellAtLeast(ticks) => tick.saturating_sub(behavior.entered_tick) >= ticks,
    }
}

/// The state `behavior` moves to on `tick`, or `None` to stay. At most one
/// transition per evaluation, the first that holds in declaration order, and
/// none at all before [`MIN_DWELL_TICKS`] in the current state. Pure: the same
/// behavior, tick and senses always give the same answer.
pub fn next_state(policy: &Policy, behavior: &Behavior, tick: u64, senses: &impl Senses) -> Option<u8> {
    if tick.saturating_sub(behavior.entered_tick) < MIN_DWELL_TICKS {
        return None;
    }
    let state = policy.states.get(behavior.state as usize)?;
    state
        .transitions
        .iter()
        .find(|transition| {
            transition
                .when
                .iter()
                .all(|condition| holds(*condition, behavior, tick, senses))
        })
        .map(|transition| transition.to)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed {
        health: (i32, i32),
        at: (f32, f32),
        outnumbered: bool,
    }

    impl Senses for Fixed {
        fn health(&self) -> (i32, i32) {
            self.health
        }
        fn position(&self) -> (f32, f32) {
            self.at
        }
        fn outnumbered(&self, _radius: f32) -> bool {
            self.outnumbered
        }
        fn enemy_within(&self, _radius: f32) -> bool {
            self.outnumbered
        }
    }

    fn running(preset: &str, state: u8, entered_tick: u64) -> Behavior {
        Behavior {
            preset: preset.into(),
            goal_x: 1000.0,
            goal_y: 0.0,
            home_x: 0.0,
            home_y: 0.0,
            state,
            entered_tick,
        }
    }

    #[test]
    fn every_preset_respects_the_trial_limits() {
        for preset in PRESETS {
            assert_eq!(validate_policy(preset), Ok(()), "{}", preset.name);
            assert!(policy(preset.name).is_some());
        }
        assert!(policy("attack_move").is_none());
    }

    #[test]
    fn the_first_matching_transition_wins_and_only_after_the_dwell() {
        let hurt = Fixed { health: (40, 100), at: (500.0, 0.0), outnumbered: true };
        let harass = policy("harass").unwrap();
        assert_eq!(next_state(harass, &running("harass", 0, 100), 119, &hurt), None);
        assert_eq!(next_state(harass, &running("harass", 0, 100), 120, &hurt), Some(1));
        let healthy = Fixed { health: (79, 100), at: (100.0, 0.0), outnumbered: false };
        assert_eq!(next_state(harass, &running("harass", 2, 0), 50, &healthy), None);
        let healed = Fixed { health: (80, 100), ..healthy };
        assert_eq!(next_state(harass, &running("harass", 2, 0), 50, &healed), Some(0));
    }
}
