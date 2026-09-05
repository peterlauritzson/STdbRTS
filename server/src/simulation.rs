use crate::{advance, distance, stats, validate_position, MAX_QUEUE, MAX_UNITS, WORLD_SIZE};
use std::collections::BTreeMap;

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub target: u32,
}

impl Order {
    pub fn idle() -> Self {
        Self {
            kind: "stop".into(),
            x: 0.0,
            y: 0.0,
            target: 0,
        }
    }
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Production {
    pub kind: String,
    pub finish_tick: u64,
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Entity {
    pub id: u32,
    pub owner: u8,
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub hp: i32,
    pub order: Order,
    pub queue: Vec<Order>,
    pub cargo: u32,
    pub returning: bool,
    pub next_attack: u64,
    pub shot_tick: u64,
    pub shot_x: f32,
    pub shot_y: f32,
    pub production: Vec<Production>,
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub amount: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Command {
    pub id: u64,
    pub owner: u8,
    pub units: Vec<u32>,
    pub order: Order,
    pub queued: bool,
    pub execute_tick: u64,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct World {
    pub tick: u64,
    pub next_id: u32,
    pub units: Vec<Entity>,
    pub nodes: Vec<Node>,
    pub commands: Vec<Command>,
    pub balances: BTreeMap<u8, u32>,
    pub outcome: Option<i16>,
}

impl World {
    pub fn new(slots: &[u8]) -> Self {
        let mut world = Self {
            tick: 0,
            next_id: 1,
            units: vec![],
            nodes: vec![],
            commands: vec![],
            balances: slots.iter().map(|slot| (*slot, 250)).collect(),
            outcome: None,
        };
        let spawns = [
            (220.0, 220.0),
            (1380.0, 1380.0),
            (1380.0, 220.0),
            (220.0, 1380.0),
        ];
        let mut ordered_slots = slots.to_vec();
        ordered_slots.sort_unstable();
        for slot in &ordered_slots {
            let (x, y) = spawns[*slot as usize];
            world.spawn(*slot, "hq", x, y);
            world.spawn(*slot, "worker", x + 55.0, y);
            world.spawn(*slot, "worker", x, y + 55.0);
            world.spawn(*slot, "soldier", x + 55.0, y + 55.0);
        }
        for (index, (x, y)) in [
            (360.0, 360.0),
            (1240.0, 1240.0),
            (1240.0, 360.0),
            (360.0, 1240.0),
            (800.0, 600.0),
            (800.0, 1000.0),
            (600.0, 800.0),
            (1000.0, 800.0),
        ]
        .into_iter()
        .enumerate()
        {
            world.nodes.push(Node {
                id: index as u32 + 1,
                x,
                y,
                amount: 4000,
            });
        }
        world
    }

    pub fn spawn(&mut self, owner: u8, kind: &str, x: f32, y: f32) {
        self.units.push(Entity {
            id: self.next_id,
            owner,
            kind: kind.into(),
            x,
            y,
            hp: stats(kind).unwrap().hp,
            order: Order::idle(),
            queue: vec![],
            cargo: 0,
            returning: false,
            next_attack: 0,
            shot_tick: 0,
            shot_x: x,
            shot_y: y,
            production: vec![],
        });
        self.next_id += 1;
    }

    pub fn validate(&self, command: &Command) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("Match has ended".into());
        }
        if !self
            .units
            .iter()
            .any(|unit| unit.owner == command.owner && unit.kind == "hq")
        {
            return Err("Your HQ has been destroyed".into());
        }
        if command.units.is_empty() || command.units.len() > MAX_UNITS {
            return Err("Select between 1 and 60 units".into());
        }
        let mut ids = command.units.clone();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != command.units.len() {
            return Err("Duplicate unit IDs".into());
        }
        let order = &command.order;
        let training = order.kind.strip_prefix("train_");
        if training.is_some() && command.units.len() != 1 {
            return Err("Select one HQ for production".into());
        }
        for id in &command.units {
            let unit = self
                .units
                .iter()
                .find(|unit| unit.id == *id && unit.owner == command.owner)
                .ok_or("Unit is missing or belongs to another player")?;
            if command.queued
                && (unit.queue.len() >= MAX_QUEUE || training.is_some() || order.kind == "stop")
            {
                return Err("Order queue is full or action cannot be queued".into());
            }
            match order.kind.as_str() {
                "move" => {
                    validate_position(order.x, order.y)?;
                    if unit.kind == "hq" {
                        return Err("HQ cannot move".into());
                    }
                }
                "attack" => {
                    if unit.kind != "soldier" {
                        return Err("Only soldiers can attack".into());
                    }
                    if !self
                        .units
                        .iter()
                        .any(|target| target.id == order.target && target.owner != unit.owner)
                    {
                        return Err("Enemy target no longer exists".into());
                    }
                }
                "gather" => {
                    if unit.kind != "worker" {
                        return Err("Only workers can gather".into());
                    }
                    if !self
                        .nodes
                        .iter()
                        .any(|node| node.id == order.target && node.amount > 0)
                    {
                        return Err("Resource node is depleted".into());
                    }
                }
                "return" => {
                    if unit.kind != "worker" {
                        return Err("Only workers carry resources".into());
                    }
                }
                "stop" => {
                    if unit.kind == "hq" {
                        return Err("HQ cannot receive movement orders".into());
                    }
                }
                "train_worker" | "train_soldier" => {
                    if unit.kind != "hq" {
                        return Err("Production requires your HQ".into());
                    }
                    let cost = stats(training.unwrap()).unwrap().cost;
                    if self.balances.get(&unit.owner).copied().unwrap_or(0) < cost {
                        return Err("Insufficient resources".into());
                    }
                    let count = self
                        .units
                        .iter()
                        .filter(|other| other.owner == unit.owner && other.kind != "hq")
                        .count();
                    if count + unit.production.len() >= MAX_UNITS {
                        return Err("Unit limit reached (60)".into());
                    }
                    if unit.production.len() >= MAX_QUEUE {
                        return Err("Production queue is full".into());
                    }
                }
                _ => return Err("Unknown order".into()),
            }
        }
        Ok(())
    }

    fn execute(&mut self, command: &Command) -> Result<(), String> {
        self.validate(command)?;
        for id in &command.units {
            let unit = self.units.iter_mut().find(|unit| unit.id == *id).unwrap();
            if let Some(kind) = command.order.kind.strip_prefix("train_") {
                let definition = stats(kind).unwrap();
                *self.balances.get_mut(&unit.owner).unwrap() -= definition.cost;
                let start = unit
                    .production
                    .last()
                    .map_or(self.tick, |item| item.finish_tick.max(self.tick));
                unit.production.push(Production {
                    kind: kind.into(),
                    finish_tick: start + definition.training_ticks,
                });
            } else if command.queued && unit.order.kind != "stop" {
                unit.queue.push(command.order.clone());
            } else {
                unit.order = command.order.clone();
                unit.returning = command.order.kind == "return";
                if !command.queued {
                    unit.queue.clear();
                }
            }
        }
        Ok(())
    }

    pub fn step(&mut self) {
        if self.outcome.is_some() {
            return;
        }
        self.tick += 1;
        self.commands
            .sort_by_key(|command| (command.execute_tick, command.id));
        for index in 0..self.commands.len() {
            if self.commands[index].status != "scheduled"
                || self.commands[index].execute_tick > self.tick
            {
                continue;
            }
            let command = self.commands[index].clone();
            match self.execute(&command) {
                Ok(()) => self.commands[index].status = "executed".into(),
                Err(reason) => {
                    self.commands[index].status = "rejected".into();
                    self.commands[index].reason = reason;
                }
            }
        }

        self.units.sort_by_key(|unit| unit.id);
        let snapshot = self.units.clone();
        let mut damage = BTreeMap::<u32, i32>::new();
        let mut births = Vec::new();
        for unit in &mut self.units {
            let definition = stats(&unit.kind).unwrap();
            if unit.kind == "hq" {
                if unit
                    .production
                    .first()
                    .is_some_and(|item| item.finish_tick <= self.tick)
                {
                    let item = unit.production.remove(0);
                    let offset = (self.next_id % 5) as f32 * 16.0 - 32.0;
                    births.push((
                        unit.owner,
                        item.kind,
                        unit.x + offset,
                        unit.y + if unit.y < 800.0 { 65.0 } else { -65.0 },
                    ));
                }
                continue;
            }
            let mut completed = false;
            match unit.order.kind.as_str() {
                "move" => {
                    completed = advance(
                        &mut unit.x,
                        &mut unit.y,
                        unit.order.x,
                        unit.order.y,
                        definition.speed,
                        0.0,
                    )
                }
                "attack" => {
                    if let Some(target) = snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target)
                    {
                        advance(
                            &mut unit.x,
                            &mut unit.y,
                            target.x,
                            target.y,
                            definition.speed,
                            definition.range * 0.9,
                        );
                    } else {
                        completed = true;
                    }
                }
                "gather" | "return" => {
                    if unit.cargo >= 25 {
                        unit.returning = true;
                    }
                    if unit.returning || unit.order.kind == "return" {
                        if let Some(hq) = snapshot
                            .iter()
                            .find(|target| target.owner == unit.owner && target.kind == "hq")
                        {
                            if advance(&mut unit.x, &mut unit.y, hq.x, hq.y, definition.speed, 45.0)
                            {
                                *self.balances.get_mut(&unit.owner).unwrap() += unit.cargo;
                                unit.cargo = 0;
                                unit.returning = false;
                                completed = unit.order.kind == "return";
                            }
                        } else {
                            completed = true;
                        }
                    } else {
                        if !self
                            .nodes
                            .iter()
                            .any(|node| node.id == unit.order.target && node.amount > 0)
                        {
                            if let Some(node) =
                                self.nodes.iter().filter(|node| node.amount > 0).min_by(
                                    |left, right| {
                                        distance(unit.x, unit.y, left.x, left.y)
                                            .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                            .then(left.id.cmp(&right.id))
                                    },
                                )
                            {
                                unit.order.target = node.id;
                            } else if unit.cargo > 0 {
                                unit.returning = true;
                            } else {
                                completed = true;
                            }
                        }
                        if let Some(node) = self
                            .nodes
                            .iter_mut()
                            .find(|node| node.id == unit.order.target && node.amount > 0)
                        {
                            if advance(
                                &mut unit.x,
                                &mut unit.y,
                                node.x,
                                node.y,
                                definition.speed,
                                28.0,
                            ) && self.tick % 10 == 0
                            {
                                let amount = 5.min(node.amount).min(25 - unit.cargo);
                                node.amount -= amount;
                                unit.cargo += amount;
                                if unit.cargo == 25 || node.amount == 0 {
                                    unit.returning = true;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            if unit.kind == "soldier" && unit.next_attack <= self.tick {
                let target = if unit.order.kind == "attack" {
                    snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target)
                } else {
                    snapshot
                        .iter()
                        .filter(|target| {
                            target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y) <= definition.range
                        })
                        .min_by(|left, right| {
                            distance(unit.x, unit.y, left.x, left.y)
                                .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                .then(left.id.cmp(&right.id))
                        })
                };
                if let Some(target) = target.filter(|target| {
                    distance(unit.x, unit.y, target.x, target.y) <= definition.range
                }) {
                    *damage.entry(target.id).or_default() += definition.damage;
                    unit.next_attack = self.tick + definition.cooldown;
                    unit.shot_tick = self.tick;
                    unit.shot_x = target.x;
                    unit.shot_y = target.y;
                }
            }
            if completed {
                unit.order = if unit.queue.is_empty() {
                    Order::idle()
                } else {
                    unit.queue.remove(0)
                };
                unit.returning = unit.order.kind == "return";
            }
        }
        for unit in &mut self.units {
            unit.hp -= damage.get(&unit.id).copied().unwrap_or(0);
        }
        self.units.retain(|unit| unit.hp > 0);
        let survivors: Vec<u8> = self
            .units
            .iter()
            .filter(|unit| unit.kind == "hq")
            .map(|unit| unit.owner)
            .collect();
        self.units.retain(|unit| survivors.contains(&unit.owner));
        for (owner, kind, x, y) in births {
            if survivors.contains(&owner) {
                self.spawn(owner, &kind, x, y);
            }
        }
        self.separate_units();
        self.resolve_outcome();
    }

    pub fn surrender(&mut self, owner: u8) {
        if self.outcome.is_some() {
            return;
        }
        self.units.retain(|unit| unit.owner != owner);
        for command in &mut self.commands {
            if command.owner == owner && command.status == "scheduled" {
                command.status = "cancelled".into();
                command.reason = "Player surrendered".into();
            }
        }
        self.resolve_outcome();
    }

    fn resolve_outcome(&mut self) {
        let survivors: Vec<u8> = self
            .units
            .iter()
            .filter(|unit| unit.kind == "hq")
            .map(|unit| unit.owner)
            .collect();
        if survivors.len() <= 1 {
            self.outcome = Some(survivors.first().map_or(-1, |slot| *slot as i16));
            for command in &mut self.commands {
                if command.status == "scheduled" {
                    command.status = "cancelled".into();
                    command.reason = "Match ended".into();
                }
            }
        }
    }

    fn separate_units(&mut self) {
        for left_index in 0..self.units.len() {
            let (left_slice, right_slice) = self.units.split_at_mut(left_index + 1);
            let left = &mut left_slice[left_index];
            if left.kind == "hq" {
                continue;
            }
            for right in right_slice {
                if right.kind == "hq" {
                    continue;
                }
                let gap = distance(left.x, left.y, right.x, right.y);
                if gap >= 18.0 {
                    continue;
                }
                let (normal_x, normal_y) = if gap < 0.01 {
                    (1.0, 0.0)
                } else {
                    ((right.x - left.x) / gap, (right.y - left.y) / gap)
                };
                let push = (18.0 - gap) * 0.5;
                left.x = (left.x - normal_x * push).clamp(16.0, WORLD_SIZE - 16.0);
                left.y = (left.y - normal_y * push).clamp(16.0, WORLD_SIZE - 16.0);
                right.x = (right.x + normal_x * push).clamp(16.0, WORLD_SIZE - 16.0);
                right.y = (right.y + normal_y * push).clamp(16.0, WORLD_SIZE - 16.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: u64, owner: u8, unit: u32, kind: &str, target: u32) -> Command {
        Command {
            id,
            owner,
            units: vec![unit],
            order: Order {
                kind: kind.into(),
                x: 500.0,
                y: 500.0,
                target,
            },
            queued: false,
            execute_tick: 20,
            status: "scheduled".into(),
            reason: String::new(),
        }
    }

    #[test]
    fn bootstrap_is_independent_of_database_iteration_order() {
        assert_eq!(World::new(&[3, 1, 0, 2]), World::new(&[0, 1, 2, 3]));
    }

    #[test]
    fn movement_waits_until_execution_tick() {
        let mut world = World::new(&[0, 1]);
        let start = world.units[1].clone();
        world.commands.push(command(1, 0, start.id, "move", 0));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[1], start);
        world.step();
        assert!(world.units[1].x > start.x);
        assert_eq!(world.commands[0].status, "executed");
    }

    #[test]
    fn rejects_foreign_units_and_unknown_actions() {
        let world = World::new(&[0, 1]);
        assert!(world.validate(&command(1, 1, 2, "move", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "teleport", 0)).is_err());
        assert!(world.validate(&command(1, 0, 1, "train_hq", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "attack", 5)).is_err());
    }

    #[test]
    fn production_is_delayed_serial_and_resource_limited() {
        let mut world = World::new(&[0, 1]);
        for id in 1..=3 {
            world.commands.push(command(id, 0, 1, "train_soldier", 0));
        }
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.balances[&0], 250);
        world.step();
        assert_eq!(world.balances[&0], 50);
        assert_eq!(world.commands[2].status, "rejected");
        assert_eq!(world.units[0].production[0].finish_tick, 120);
        assert_eq!(world.units[0].production[1].finish_tick, 220);
        for _ in 20..120 {
            world.step();
        }
        assert_eq!(
            world
                .units
                .iter()
                .filter(|unit| unit.owner == 0 && unit.kind == "soldier")
                .count(),
            2
        );
    }

    #[test]
    fn workers_credit_only_after_returning_cargo() {
        let mut world = World::new(&[0, 1]);
        world.units[1].x = 360.0;
        world.units[1].y = 335.0;
        world.commands.push(command(1, 0, 2, "gather", 1));
        for _ in 0..60 {
            world.step();
        }
        assert_eq!(world.balances[&0], 250);
        assert_eq!(world.units[1].cargo, 25);
        for _ in 0..50 {
            world.step();
        }
        assert_eq!(world.balances[&0], 275);
        assert_eq!(world.units[1].cargo, 0);
    }

    #[test]
    fn simultaneous_hq_deaths_are_a_draw() {
        let mut world = World::new(&[0, 1]);
        world.units[0].hp = 18;
        world.units[4].hp = 18;
        world.units[3].x = 1370.0;
        world.units[3].y = 1370.0;
        world.units[3].order = Order {
            kind: "attack".into(),
            x: 0.0,
            y: 0.0,
            target: 5,
        };
        world.units[7].x = 230.0;
        world.units[7].y = 230.0;
        world.units[7].order = Order {
            kind: "attack".into(),
            x: 0.0,
            y: 0.0,
            target: 1,
        };
        world.step();
        assert_eq!(world.outcome, Some(-1));
        assert!(world.units.is_empty());
    }

    #[test]
    fn four_player_match_continues_after_one_elimination() {
        let mut world = World::new(&[0, 1, 2, 3]);
        world.units[0].hp = 0;
        world.step();
        assert_eq!(world.outcome, None);
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
    }

    #[test]
    fn queued_orders_do_not_activate_early_and_stop_clears_them() {
        let mut world = World::new(&[0, 1]);
        let mut queued = command(1, 0, 2, "move", 0);
        queued.queued = true;
        world.commands.push(queued);
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[1].order.kind, "stop");
        world.step();
        let mut stop = command(2, 0, 2, "stop", 0);
        stop.execute_tick = 40;
        world.commands.push(stop);
        for _ in 20..40 {
            world.step();
        }
        assert_eq!(world.units[1].order.kind, "stop");
        assert!(world.units[1].queue.is_empty());
    }

    #[test]
    fn surrender_never_advances_time_or_executes_orders() {
        let mut world = World::new(&[0, 1, 2, 3]);
        world.commands.push(command(1, 0, 2, "move", 0));
        world.surrender(0);
        assert_eq!(world.tick, 0);
        assert_eq!(world.outcome, None);
        assert_eq!(world.commands[0].status, "cancelled");
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
        world.surrender(1);
        world.surrender(2);
        assert_eq!(world.outcome, Some(3));
    }

    #[test]
    fn disappeared_targets_are_rejected_at_execution() {
        let mut world = World::new(&[0, 1]);
        world.commands.push(command(1, 0, 4, "attack", 6));
        assert!(world.validate(&world.commands[0]).is_ok());
        world.units.retain(|unit| unit.id != 6);
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.commands[0].status, "rejected");
        assert_eq!(
            world
                .units
                .iter()
                .find(|unit| unit.id == 4)
                .unwrap()
                .order
                .kind,
            "stop"
        );
    }

    #[test]
    fn production_and_order_queues_are_bounded() {
        let mut world = World::new(&[0, 1]);
        while world
            .units
            .iter()
            .filter(|unit| unit.owner == 0 && unit.kind != "hq")
            .count()
            < MAX_UNITS
        {
            world.spawn(0, "worker", 600.0, 600.0);
        }
        assert!(world
            .validate(&command(1, 0, 1, "train_worker", 0))
            .is_err());
        world.units[1].queue = vec![Order::idle(); MAX_QUEUE];
        let mut queued = command(2, 0, 2, "move", 0);
        queued.queued = true;
        assert!(world.validate(&queued).is_err());
    }

    #[test]
    fn soldiers_pursue_and_destroy_a_target_hq() {
        let mut world = World::new(&[0, 1]);
        world
            .units
            .retain(|unit| unit.owner == 0 || unit.kind == "hq");
        world.commands.push(command(1, 0, 4, "attack", 5));
        for _ in 0..1500 {
            world.step();
        }
        assert_eq!(world.outcome, Some(0));
        assert!(world.units.iter().all(|unit| unit.owner == 0));
    }

    #[test]
    fn replay_and_twenty_minute_soak_remain_deterministic() {
        let mut first = World::new(&[0, 1, 2, 3]);
        for slot in 0..4 {
            first.commands.push(command(
                slot as u64 + 1,
                slot,
                slot as u32 * 4 + 2,
                "gather",
                slot as u32 + 1,
            ));
        }
        let mut second = first.clone();
        for _ in 0..24000 {
            first.step();
            second.step();
        }
        assert_eq!(first, second);
        assert!(first
            .units
            .iter()
            .all(|unit| unit.x.is_finite() && unit.y.is_finite()));
        let remaining: u32 = first.nodes.iter().map(|node| node.amount).sum();
        let cargo: u32 = first.units.iter().map(|unit| unit.cargo).sum();
        assert_eq!(
            first.balances.values().sum::<u32>() + remaining + cargo,
            33000
        );
    }
}
