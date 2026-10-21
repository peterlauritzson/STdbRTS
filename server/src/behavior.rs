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
#[derive(Clone, Debug, PartialEq)]
pub struct Transition {
    pub when: Vec<Condition>,
    pub to: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct State {
    /// Shown to players beside the preset ("Harass · retreat").
    pub name: String,
    pub action: Action,
    /// Tried in order; the first whose conditions all hold wins.
    pub transitions: Vec<Transition>,
}

/// A whole behavior. State 0 is the initial state.
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// The order kind that activates it, and its persisted id: a preset's
    /// name, or `custom_<n>` for a player's own.
    pub name: String,
    /// What a player calls it ("Harass", or whatever they typed).
    pub label: String,
    pub states: Vec<State>,
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

/// The presets, written in the same text a player's policy is submitted in
/// (see [`parse_policy`]), so presets and authored policies cannot drift apart.
/// Harass's "recover" holds at home: a unit that cannot heal stays there as a
/// home defender, too hurt to harass and still useful. Guard's "watch" is the
/// leash: dragged more than 600 away by a chase, the unit walks back without
/// fighting rather than following a kite across the map. Assault (the mission
/// layer's Rush and strike) attack-moves and never retreats.
pub const PRESET_TEXTS: [(&str, &str); 4] = [
    (
        "harass",
        "Harass|1|advance,attack_move:goal,1:health_below=50,1:outnumbered=350\
         |retreat,move:home,2:near_home=250|recover,hold,0:health_at_least=80",
    ),
    (
        "guard",
        "Guard|0|return,move:goal,1:near_goal=150|watch,attack_move:goal,0:far_goal=600",
    ),
    (
        "raid",
        "Raid|0|advance,attack_move:goal,1:health_below=35\
         |retreat,move:home,2:near_home=250|recover,hold,0:health_at_least=90",
    ),
    ("assault", "Rush|0|assault,attack_move:goal"),
];

/// Every preset, in the order a client lists them.
pub fn presets() -> &'static [Policy] {
    static PRESETS: std::sync::OnceLock<Vec<Policy>> = std::sync::OnceLock::new();
    PRESETS.get_or_init(|| {
        PRESET_TEXTS
            .iter()
            .map(|(name, text)| parse_policy(name, text).expect("preset text parses"))
            .collect()
    })
}

/// The preset an order kind activates, or `None` for an ordinary order (and
/// for a player's `custom_<n>`, which only [`lookup`] resolves).
pub fn policy(name: &str) -> Option<&'static Policy> {
    presets().iter().find(|policy| policy.name == name)
}

/// How many policies of their own a player may define.
pub const MAX_CUSTOM: u8 = 4;
/// The longest policy text accepted.
pub const MAX_POLICY_TEXT: usize = 2000;
/// The longest a dwell condition may ask for: ten minutes.
pub const MAX_DWELL_TICKS: u64 = 12_000;

/// A player's own policy, as submitted and as parsed.
#[derive(Clone, Debug, PartialEq)]
pub struct Custom {
    /// The text it was defined with, kept verbatim for the table row.
    pub text: String,
    pub policy: Policy,
}

/// Every player's own policies, by `(owner, number)`.
pub type Customs = std::collections::BTreeMap<(u8, u8), Custom>;

/// `n` for the order kind `custom_<n>`, 1 to [`MAX_CUSTOM`].
pub fn custom_number(name: &str) -> Option<u8> {
    let digits = name.strip_prefix("custom_")?;
    if digits.len() != 1 {
        return None;
    }
    digits
        .parse::<u8>()
        .ok()
        .filter(|number| (1..=MAX_CUSTOM).contains(number))
}

/// Is `name` a behavior order kind at all: a preset, or any `custom_<n>`,
/// defined yet or not.
pub fn is_behavior_name(name: &str) -> bool {
    policy(name).is_some() || custom_number(name).is_some()
}

/// The policy `owner` means by `name`: a preset, or one of their own.
pub fn lookup<'a>(customs: &'a Customs, owner: u8, name: &str) -> Option<&'a Policy> {
    match custom_number(name) {
        Some(number) => customs.get(&(owner, number)).map(|custom| &custom.policy),
        None => policy(name),
    }
}

fn parse_action(text: &str) -> Result<Action, String> {
    let anchor = |name: &str| match name {
        "goal" => Ok(Anchor::Goal),
        "home" => Ok(Anchor::Home),
        _ => Err(format!("Unknown anchor \"{name}\"")),
    };
    match text.split_once(':') {
        None if text == "hold" => Ok(Action::Hold),
        Some(("attack_move", at)) => Ok(Action::AttackMove(anchor(at)?)),
        Some(("move", at)) => Ok(Action::Move(anchor(at)?)),
        _ => Err(format!("Unknown action \"{text}\"")),
    }
}

fn parse_condition(text: &str) -> Result<Condition, String> {
    let (name, value) = text
        .split_once('=')
        .ok_or_else(|| format!("A condition is name=value, not \"{text}\""))?;
    let number = || {
        value
            .parse::<f32>()
            .ok()
            .filter(|number| number.is_finite())
            .ok_or_else(|| format!("\"{value}\" is not a number"))
    };
    let percent = || {
        value
            .parse::<u8>()
            .map_err(|_| format!("\"{value}\" is not a percentage"))
    };
    Ok(match name {
        "health_below" => Condition::HealthBelow(percent()?),
        "health_at_least" => Condition::HealthAtLeast(percent()?),
        "outnumbered" => Condition::Outnumbered { radius: number()? },
        "no_enemy" => Condition::NoEnemyWithin(number()?),
        "near_goal" => Condition::Near(Anchor::Goal, number()?),
        "near_home" => Condition::Near(Anchor::Home, number()?),
        "far_goal" => Condition::FartherThan(Anchor::Goal, number()?),
        "far_home" => Condition::FartherThan(Anchor::Home, number()?),
        "dwell" => Condition::DwellAtLeast(
            value
                .parse::<u64>()
                .map_err(|_| format!("\"{value}\" is not a tick count"))?,
        ),
        _ => return Err(format!("Unknown condition \"{name}\"")),
    })
}

/// A label or state name: 1 to `longest` letters, digits, spaces, `-` or `_`,
/// so it can never contain the text's own separators.
fn checked_name(text: &str, longest: usize, what: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty()
        || text.chars().count() > longest
        || !text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_'))
    {
        return Err(format!(
            "A {what} is 1 to {longest} letters, digits, spaces, - or _"
        ));
    }
    Ok(text.to_string())
}

/// Parses a policy's text into the policy `name` and checks it against the
/// trial limits ([`validate_policy`]). The format is one line:
///
/// ```text
/// label|labour|state|state...
/// state      = name,action[,transition]...
/// action     = attack_move:goal | attack_move:home | move:goal | move:home | hold
/// transition = to:[condition[&condition]]
/// condition  = health_below=P | health_at_least=P | outnumbered=R | no_enemy=R
///            | near_goal=D | near_home=D | far_goal=D | far_home=D | dwell=T
/// ```
///
/// `labour` is `1` to prefer enemy labour while attack-moving, else `0`; `to`
/// is a state index (0 is the initial state); `P` is a percentage, `R` a query
/// radius, `D` a distance, `T` ticks (20 a second). A transition with no
/// conditions holds as soon as the minimum dwell has passed.
pub fn parse_policy(name: &str, text: &str) -> Result<Policy, String> {
    if text.len() > MAX_POLICY_TEXT {
        return Err(format!("A policy is at most {MAX_POLICY_TEXT} characters"));
    }
    let mut parts = text.split('|');
    let label = checked_name(parts.next().unwrap_or(""), 20, "behavior name")?;
    let prefers_labour = match parts.next().map(str::trim) {
        Some("0") => false,
        Some("1") => true,
        _ => return Err("The second field is 1 (prefer labour) or 0".into()),
    };
    let mut states = Vec::new();
    for part in parts {
        if states.len() == MAX_STATES {
            return Err(format!("A policy has 1 to {MAX_STATES} states"));
        }
        let mut fields = part.split(',').map(str::trim);
        let state_name = checked_name(fields.next().unwrap_or(""), 12, "state name")?;
        let action = parse_action(fields.next().unwrap_or(""))?;
        let mut transitions = Vec::new();
        for field in fields {
            if transitions.len() == MAX_TRANSITIONS {
                return Err(format!("A state has at most {MAX_TRANSITIONS} transitions"));
            }
            let (to, when) = field
                .split_once(':')
                .ok_or_else(|| format!("A transition is to:conditions, not \"{field}\""))?;
            let to = to
                .trim()
                .parse::<u8>()
                .map_err(|_| format!("\"{to}\" is not a state number"))?;
            let when = when
                .split('&')
                .map(str::trim)
                .filter(|condition| !condition.is_empty())
                .take(MAX_CONDITIONS + 1)
                .map(parse_condition)
                .collect::<Result<Vec<_>, _>>()?;
            transitions.push(Transition { when, to });
        }
        states.push(State {
            name: state_name,
            action,
            transitions,
        });
    }
    let policy = Policy {
        name: name.into(),
        label,
        states,
        prefers_labour,
    };
    validate_policy(&policy)?;
    Ok(policy)
}

/// The two labels the public `unit` row carries: the policy and the state
/// name, both `None` for a unit with no behavior. The policy label is the order
/// kind (`custom_<n>` for a player's own, which a client names from the
/// `policy` table).
pub fn labels_in(
    customs: &Customs,
    owner: u8,
    behavior: Option<&Behavior>,
) -> (Option<String>, Option<String>) {
    match behavior {
        Some(behavior) => (
            Some(behavior.preset.clone()),
            lookup(customs, owner, &behavior.preset)
                .and_then(|policy| policy.states.get(behavior.state as usize))
                .map(|state| state.name.clone()),
        ),
        None => (None, None),
    }
}

/// [`labels_in`] for a unit that can only be running a preset.
pub fn labels(behavior: Option<&Behavior>) -> (Option<String>, Option<String>) {
    labels_in(&Customs::new(), 0, behavior)
}

/// Checks a policy against the trial limits: state, transition and condition
/// counts, transition targets inside the policy, percentages that are
/// percentages, and query radii within [`MAX_QUERY_RADIUS`]. The presets are
/// checked by a test; an authored policy will be checked here on submission.
pub fn validate_policy(policy: &Policy) -> Result<(), String> {
    if policy.states.is_empty() || policy.states.len() > MAX_STATES {
        return Err(format!("A policy has 1 to {MAX_STATES} states"));
    }
    for state in &policy.states {
        if state.transitions.len() > MAX_TRANSITIONS {
            return Err(format!("A state has at most {MAX_TRANSITIONS} transitions"));
        }
        for transition in &state.transitions {
            if transition.when.len() > MAX_CONDITIONS {
                return Err(format!(
                    "A transition tests at most {MAX_CONDITIONS} conditions"
                ));
            }
            if transition.to as usize >= policy.states.len() {
                return Err("A transition leads to a state that does not exist".into());
            }
            for condition in &transition.when {
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
                    Condition::DwellAtLeast(ticks) => {
                        if ticks > MAX_DWELL_TICKS {
                            return Err(format!("A dwell is at most {MAX_DWELL_TICKS} ticks"));
                        }
                        continue;
                    }
                };
                if !radius.is_finite() || radius <= 0.0 || radius > MAX_QUERY_RADIUS {
                    return Err(format!(
                        "A query radius is above 0 and at most {MAX_QUERY_RADIUS}"
                    ));
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
pub fn next_state(
    policy: &Policy,
    behavior: &Behavior,
    tick: u64,
    senses: &impl Senses,
) -> Option<u8> {
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
        for preset in presets() {
            assert_eq!(validate_policy(preset), Ok(()), "{}", preset.name);
            assert!(policy(&preset.name).is_some());
        }
        assert!(policy("attack_move").is_none());
    }

    #[test]
    fn assault_attack_moves_to_the_goal_and_never_leaves_it() {
        let assault = policy("assault").expect("assault preset");
        assert_eq!(assault.states.len(), 1);
        assert_eq!(assault.states[0].action, Action::AttackMove(Anchor::Goal));
        assert!(assault.states[0].transitions.is_empty());
        let hurt = Fixed {
            health: (1, 100),
            at: (500.0, 0.0),
            outnumbered: true,
        };
        assert_eq!(
            next_state(assault, &running("assault", 0, 0), 10_000, &hurt),
            None
        );
    }

    #[test]
    fn the_first_matching_transition_wins_and_only_after_the_dwell() {
        let hurt = Fixed {
            health: (40, 100),
            at: (500.0, 0.0),
            outnumbered: true,
        };
        let harass = policy("harass").unwrap();
        assert_eq!(
            next_state(harass, &running("harass", 0, 100), 119, &hurt),
            None
        );
        assert_eq!(
            next_state(harass, &running("harass", 0, 100), 120, &hurt),
            Some(1)
        );
        let healthy = Fixed {
            health: (79, 100),
            at: (100.0, 0.0),
            outnumbered: false,
        };
        assert_eq!(
            next_state(harass, &running("harass", 2, 0), 50, &healthy),
            None
        );
        let healed = Fixed {
            health: (80, 100),
            ..healthy
        };
        assert_eq!(
            next_state(harass, &running("harass", 2, 0), 50, &healed),
            Some(0)
        );
    }

    #[test]
    fn a_policy_text_parses_into_the_states_it_names() {
        let policy = parse_policy(
            "custom_1",
            "Skirmish|1|fight, attack_move:goal, 1:health_below=40&outnumbered=300, 2:dwell=200             |back,move:home,2:near_home=200|rest,hold,0:health_at_least=95&no_enemy=400",
        )
        .unwrap();
        assert_eq!((policy.label.as_str(), policy.prefers_labour), ("Skirmish", true));
        assert_eq!(policy.states.len(), 3);
        assert_eq!(policy.states[0].action, Action::AttackMove(Anchor::Goal));
        assert_eq!(
            policy.states[0].transitions[0],
            Transition {
                when: vec![
                    Condition::HealthBelow(40),
                    Condition::Outnumbered { radius: 300.0 }
                ],
                to: 1
            }
        );
        assert_eq!(policy.states[0].transitions[1].when, vec![Condition::DwellAtLeast(200)]);
        assert_eq!(policy.states[2].action, Action::Hold);
        assert!(parse_policy("custom_1", &format!("Long|0|{}", "a,hold|".repeat(9))).is_err());
        assert!(parse_policy("custom_1", "Too|0|a,hold,0:,0:,0:,0:,0:").is_err());
        assert!(parse_policy("custom_1", "Bad|name|0|a,hold").is_err());
        assert!(parse_policy("custom_1", "Far|0|a,hold,0:dwell=999999").is_err());
    }

    #[test]
    fn custom_slots_are_one_to_four() {
        assert_eq!(custom_number("custom_1"), Some(1));
        assert_eq!(custom_number("custom_4"), Some(4));
        for bad in ["custom_0", "custom_5", "custom_10", "custom_", "custom_x", "harass"] {
            assert_eq!(custom_number(bad), None, "{bad}");
        }
        assert!(is_behavior_name("custom_2"));
        assert!(is_behavior_name("raid"));
        assert!(!is_behavior_name("attack_move"));
    }
}
