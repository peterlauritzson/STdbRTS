use crate::navigation::{line_of_sight, terrain_free, Navigation};
use crate::{
    attack_damage, distance, is_army, is_building, producer, stats, validate_position,
    MAX_BUILDINGS, MAX_QUEUE, MAX_UNITS, WORLD_SIZE,
};
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
    pub construction_remaining: u64,
    pub research: Vec<String>,
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
        let map = crate::maps::default_map();
        let mut ordered_slots = slots.to_vec();
        ordered_slots.sort_unstable();
        for slot in &ordered_slots {
            let [x, y] = map.starts[*slot as usize];
            world.spawn(*slot, "hq", x, y);
            world.spawn(*slot, "worker", x + 55.0, y);
            world.spawn(*slot, "worker", x, y + 55.0);
            world.spawn(*slot, "soldier", x + 55.0, y + 55.0);
        }
        for deposit in &map.deposits {
            world.nodes.push(Node {
                id: deposit.id,
                x: deposit.x,
                y: deposit.y,
                amount: deposit.amount,
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
            construction_remaining: 0,
            research: vec![],
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
        if let Some(kind) = order.kind.strip_prefix("build_") {
            if !is_building(kind) || kind == "hq" {
                return Err("Unknown building".into());
            }
            if command.units.len() != 1 || command.queued {
                return Err("Select one worker; construction cannot be queued".into());
            }
            validate_position(order.x, order.y)?;
            if !terrain_free(order.x, order.y, 50.0) {
                return Err("Building site intersects terrain".into());
            }
            if !(60.0..=1540.0).contains(&order.x) || !(60.0..=1540.0).contains(&order.y) {
                return Err("Building too close to map edge".into());
            }
            if self.units.iter().any(|unit| {
                is_building(&unit.kind) && distance(order.x, order.y, unit.x, unit.y) < 110.0
            }) || self
                .nodes
                .iter()
                .any(|node| distance(order.x, order.y, node.x, node.y) < 75.0)
            {
                return Err("Building site is obstructed".into());
            }
            if self.units.iter().any(|unit| {
                !is_building(&unit.kind) && distance(order.x, order.y, unit.x, unit.y) < 55.0
            }) {
                return Err("Move units clear of the building site".into());
            }
            if !self.units.iter().any(|unit| {
                unit.owner == command.owner
                    && is_building(&unit.kind)
                    && unit.construction_remaining == 0
                    && distance(order.x, order.y, unit.x, unit.y) <= 500.0
            }) {
                return Err("Build within 500 units of your established base".into());
            }
            if kind == "factory"
                && !self.units.iter().any(|unit| {
                    unit.owner == command.owner
                        && unit.kind == "barracks"
                        && unit.construction_remaining == 0
                })
            {
                return Err("Build a barracks before a factory".into());
            }
            if self
                .units
                .iter()
                .filter(|unit| unit.owner == command.owner && is_building(&unit.kind))
                .count()
                >= MAX_BUILDINGS
            {
                return Err("Building limit reached (16)".into());
            }
            if self.balances.get(&command.owner).copied().unwrap_or(0) < stats(kind).unwrap().cost {
                return Err("Insufficient resources".into());
            }
        }
        let training = order.kind.strip_prefix("train_");
        let production_control = matches!(
            order.kind.as_str(),
            "rally_move" | "rally_gather" | "clear_rally" | "cancel_production"
        );
        if production_control && (command.units.len() != 1 || command.queued) {
            return Err("Select one HQ; production controls cannot be queued".into());
        }
        if training.is_some() && command.units.len() != 1 {
            return Err("Select one HQ for production".into());
        }
        for id in &command.units {
            let unit = self
                .units
                .iter()
                .find(|unit| unit.id == *id && unit.owner == command.owner)
                .ok_or("Unit is missing or belongs to another player")?;
            if unit.construction_remaining > 0 && order.kind != "cancel_construction" {
                return Err("Building is still under construction".into());
            }
            if command.queued
                && (unit.queue.len() >= MAX_QUEUE
                    || training.is_some()
                    || matches!(order.kind.as_str(), "stop" | "hold"))
            {
                return Err("Order queue is full or action cannot be queued".into());
            }
            match order.kind.as_str() {
                kind if kind.starts_with("build_") => {
                    if unit.kind != "worker" {
                        return Err("Only workers can construct buildings".into());
                    }
                }
                "construct" => {
                    if unit.kind != "worker"
                        || !self.units.iter().any(|target| {
                            target.id == order.target
                                && target.owner == unit.owner
                                && target.construction_remaining > 0
                        })
                    {
                        return Err("Select a worker and an unfinished friendly building".into());
                    }
                }
                "cancel_construction" => {
                    if command.queued
                        || command.units.len() != 1
                        || unit.construction_remaining == 0
                    {
                        return Err("Select one unfinished building".into());
                    }
                }
                "research_weapons" | "research_armor" | "research_logistics" => {
                    if unit.kind != "lab" || command.queued || command.units.len() != 1 {
                        return Err("Research requires one completed lab".into());
                    }
                    if self.units.iter().any(|other| {
                        other.owner == unit.owner
                            && (other.research.contains(&order.kind)
                                || other.production.iter().any(|item| item.kind == order.kind))
                    }) {
                        return Err("Technology already researched or queued".into());
                    }
                    if unit.production.len() >= MAX_QUEUE
                        || self.balances[&unit.owner] < stats(&order.kind).unwrap().cost
                    {
                        return Err("Insufficient resources or full research queue".into());
                    }
                }
                "rally_move" | "rally_gather" | "clear_rally" | "cancel_production" => {
                    if !matches!(unit.kind.as_str(), "hq" | "barracks" | "factory" | "lab") {
                        return Err(
                            "Production controls require an HQ or production building".into()
                        );
                    }
                    if order.kind == "rally_move" {
                        validate_position(order.x, order.y)?;
                        if !Navigation::new(&self.units).free(order.x, order.y) {
                            return Err("Rally destination is obstructed".into());
                        }
                    }
                    if order.kind == "rally_gather"
                        && !self
                            .nodes
                            .iter()
                            .any(|node| node.id == order.target && node.amount > 0)
                    {
                        return Err("Resource node is depleted".into());
                    }
                    if order.kind == "cancel_production" && unit.production.is_empty() {
                        return Err("Production queue is already empty".into());
                    }
                }
                "repair" => {
                    if unit.kind != "worker" {
                        return Err("Only workers can repair".into());
                    }
                    let target = self
                        .units
                        .iter()
                        .find(|target| {
                            target.id == order.target
                                && target.owner == unit.owner
                                && target.id != unit.id
                        })
                        .ok_or("Select another friendly unit or HQ to repair")?;
                    if target.construction_remaining > 0 {
                        return Err("Resume construction instead of repairing this building".into());
                    }
                    if target.hp >= stats(&target.kind).unwrap().hp {
                        return Err("Target is already fully repaired".into());
                    }
                }
                "move" | "attack_move" => {
                    validate_position(order.x, order.y)?;
                    if !Navigation::new(&self.units).free(order.x, order.y) {
                        return Err("Destination is obstructed".into());
                    }
                    if order.kind == "attack_move" && !is_army(&unit.kind) {
                        return Err(
                            "Only army units (soldiers, scouts, siege) can attack-move".into()
                        );
                    }
                    if is_building(&unit.kind) {
                        return Err("HQ and buildings cannot move".into());
                    }
                }
                "hold" => {
                    if !is_army(&unit.kind) {
                        return Err(
                            "Only army units (soldiers, scouts, siege) can hold position".into(),
                        );
                    }
                }
                "attack" => {
                    if !is_army(&unit.kind) {
                        return Err("Only army units (soldiers, scouts, siege) can attack".into());
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
                    if is_building(&unit.kind) {
                        return Err("HQ cannot receive movement orders".into());
                    }
                }
                "train_worker" | "train_soldier" | "train_scout" | "train_siege" => {
                    if !producer(training.unwrap(), &unit.kind) {
                        return Err(
                            "Production requires the correct HQ, barracks, or factory".into()
                        );
                    }
                    let cost = stats(training.unwrap()).unwrap().cost;
                    if self.balances.get(&unit.owner).copied().unwrap_or(0) < cost {
                        return Err("Insufficient resources".into());
                    }
                    let count = self
                        .units
                        .iter()
                        .filter(|other| other.owner == unit.owner && !is_building(&other.kind))
                        .count();
                    let pending: usize = self
                        .units
                        .iter()
                        .filter(|other| other.owner == unit.owner)
                        .map(|other| {
                            other
                                .production
                                .iter()
                                .filter(|item| !item.kind.starts_with("research_"))
                                .count()
                        })
                        .sum();
                    if count + pending >= MAX_UNITS {
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
        if let Some(kind) = command.order.kind.strip_prefix("build_") {
            let definition = stats(kind).unwrap();
            *self.balances.get_mut(&command.owner).unwrap() -= definition.cost;
            let building_id = self.next_id;
            self.spawn(command.owner, kind, command.order.x, command.order.y);
            let site = self.units.last_mut().unwrap();
            site.construction_remaining = definition.training_ticks;
            site.hp = definition.hp / 10;
            let worker = self
                .units
                .iter_mut()
                .find(|unit| unit.id == command.units[0])
                .unwrap();
            worker.order = Order {
                kind: "construct".into(),
                target: building_id,
                ..command.order.clone()
            };
            worker.queue.clear();
            return Ok(());
        }
        if command.order.kind == "cancel_construction" {
            let site = self
                .units
                .iter()
                .find(|unit| unit.id == command.units[0])
                .unwrap();
            *self.balances.get_mut(&command.owner).unwrap() +=
                stats(&site.kind).unwrap().cost * 3 / 4;
            self.units.retain(|unit| unit.id != command.units[0]);
            return Ok(());
        }
        for id in &command.units {
            let unit = self.units.iter_mut().find(|unit| unit.id == *id).unwrap();
            if let Some(kind) = command.order.kind.strip_prefix("train_").or_else(|| {
                command
                    .order
                    .kind
                    .starts_with("research_")
                    .then_some(command.order.kind.as_str())
            }) {
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
            } else if command.order.kind == "cancel_production" {
                let refund: u32 = unit
                    .production
                    .iter()
                    .map(|item| stats(&item.kind).unwrap().cost)
                    .sum();
                *self.balances.get_mut(&unit.owner).unwrap() += refund;
                unit.production.clear();
            } else if command.order.kind == "clear_rally" {
                unit.order = Order::idle();
            } else if command.queued && unit.order.kind != "stop" {
                unit.queue.push(command.order.clone());
            } else {
                unit.order = command.order.clone();
                if unit.order.kind == "attack_move" {
                    unit.order.target = 0;
                }
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
        let navigation = Navigation::new(&snapshot);
        let advance = |x: &mut f32, y: &mut f32, target_x, target_y, speed, range| {
            navigation.advance(x, y, target_x, target_y, speed, range)
        };
        let mut damage = BTreeMap::<u32, i32>::new();
        let mut repairs = BTreeMap::<u32, i32>::new();
        let mut births = Vec::new();
        let mut construction = BTreeMap::<u32, u64>::new();
        let mut discoveries = Vec::new();
        for unit in &mut self.units {
            if unit.construction_remaining > 0 {
                continue;
            }
            let definition = stats(&unit.kind).unwrap();
            let technology = snapshot
                .iter()
                .find(|other| other.owner == unit.owner && other.kind == "hq")
                .map(|hq| &hq.research);
            let has_tech = |kind: &str| {
                technology.is_some_and(|research| research.iter().any(|item| item == kind))
            };
            let capacity = if has_tech("research_logistics") {
                40
            } else {
                25
            };
            if is_building(&unit.kind) {
                let exit = [65.0, 100.0, 140.0].into_iter().find_map(|radius| {
                    (0..8).find_map(|index| {
                        let angle = (index as f32 + 2.0) * std::f32::consts::FRAC_PI_4;
                        let point = (unit.x + radius * angle.cos(), unit.y + radius * angle.sin());
                        (navigation.free(point.0, point.1)
                            && !snapshot.iter().any(|other| {
                                !is_building(&other.kind)
                                    && distance(point.0, point.1, other.x, other.y) < 20.0
                            }))
                        .then_some(point)
                    })
                });
                if unit.production.first().is_some_and(|item| {
                    item.finish_tick <= self.tick
                        && (item.kind.starts_with("research_") || exit.is_some())
                }) {
                    let item = unit.production.remove(0);
                    if item.kind.starts_with("research_") {
                        discoveries.push((unit.owner, item.kind));
                    } else {
                        let (spawn_x, spawn_y) = exit.unwrap();
                        births.push((unit.owner, item.kind, spawn_x, spawn_y, unit.order.clone()));
                    }
                }
                if unit.kind != "turret" {
                    continue;
                }
            }
            let mut completed = false;
            match unit.order.kind.as_str() {
                "construct" => {
                    if let Some(target) = snapshot.iter().find(|target| {
                        target.id == unit.order.target
                            && target.owner == unit.owner
                            && target.construction_remaining > 0
                    }) {
                        if advance(
                            &mut unit.x,
                            &mut unit.y,
                            target.x,
                            target.y,
                            definition.speed,
                            60.0,
                        ) {
                            *construction.entry(target.id).or_default() += 1;
                        }
                    } else {
                        completed = true;
                    }
                }
                "repair" => {
                    if let Some(target) = snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target && target.owner == unit.owner)
                    {
                        let missing = stats(&target.kind).unwrap().hp
                            - target.hp
                            - repairs.get(&target.id).copied().unwrap_or(0);
                        if missing <= 0 {
                            completed = true;
                        } else if advance(
                            &mut unit.x,
                            &mut unit.y,
                            target.x,
                            target.y,
                            definition.speed,
                            if is_building(&target.kind) {
                                55.0
                            } else {
                                24.0
                            },
                        ) && self.tick % 10 == 0
                        {
                            let balance = self.balances.get_mut(&unit.owner).unwrap();
                            if *balance > 0 {
                                *balance -= 1;
                                let repaired = missing.min(5);
                                *repairs.entry(target.id).or_default() += repaired;
                                completed = repaired == missing;
                            }
                        }
                    } else {
                        completed = true;
                    }
                }
                "attack_move" => {
                    let target = snapshot
                        .iter()
                        .find(|target| {
                            target.id == unit.order.target
                                && target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y)
                                    <= definition.range.max(180.0)
                        })
                        .or_else(|| {
                            snapshot
                                .iter()
                                .filter(|target| {
                                    target.owner != unit.owner
                                        && distance(unit.x, unit.y, target.x, target.y)
                                            <= definition.range.max(180.0)
                                })
                                .min_by(|left, right| {
                                    distance(unit.x, unit.y, left.x, left.y)
                                        .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                        .then(left.id.cmp(&right.id))
                                })
                        });
                    if let Some(target) = target {
                        unit.order.target = target.id;
                        let stop_range = if line_of_sight(unit.x, unit.y, target.x, target.y) {
                            definition.range * 0.9
                        } else {
                            55.0
                        };
                        advance(
                            &mut unit.x,
                            &mut unit.y,
                            target.x,
                            target.y,
                            definition.speed,
                            stop_range,
                        );
                    } else {
                        unit.order.target = 0;
                        completed = advance(
                            &mut unit.x,
                            &mut unit.y,
                            unit.order.x,
                            unit.order.y,
                            definition.speed,
                            0.0,
                        );
                    }
                }
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
                        let stop_range = if line_of_sight(unit.x, unit.y, target.x, target.y) {
                            definition.range * 0.9
                        } else {
                            55.0
                        };
                        advance(
                            &mut unit.x,
                            &mut unit.y,
                            target.x,
                            target.y,
                            definition.speed,
                            stop_range,
                        );
                    } else {
                        completed = true;
                    }
                }
                "gather" | "return" => {
                    if unit.cargo >= capacity {
                        unit.returning = true;
                    }
                    if unit.returning || unit.order.kind == "return" {
                        if let Some(hq) = snapshot
                            .iter()
                            .filter(|target| {
                                target.owner == unit.owner
                                    && matches!(target.kind.as_str(), "hq" | "outpost")
                                    && target.construction_remaining == 0
                            })
                            .min_by(|left, right| {
                                distance(unit.x, unit.y, left.x, left.y)
                                    .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                    .then(left.id.cmp(&right.id))
                            })
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
                                let amount = (if has_tech("research_logistics") { 7 } else { 5 })
                                    .min(node.amount)
                                    .min(capacity - unit.cargo);
                                node.amount -= amount;
                                unit.cargo += amount;
                                if unit.cargo == capacity || node.amount == 0 {
                                    unit.returning = true;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            if definition.damage > 0 && unit.next_attack <= self.tick {
                let target = if matches!(unit.order.kind.as_str(), "attack" | "attack_move") {
                    snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target)
                } else {
                    snapshot
                        .iter()
                        .filter(|target| {
                            target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y) <= definition.range
                                && line_of_sight(unit.x, unit.y, target.x, target.y)
                        })
                        .min_by(|left, right| {
                            distance(unit.x, unit.y, left.x, left.y)
                                .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                .then(left.id.cmp(&right.id))
                        })
                };
                if let Some(target) = target.filter(|target| {
                    distance(unit.x, unit.y, target.x, target.y) <= definition.range
                        && line_of_sight(unit.x, unit.y, target.x, target.y)
                }) {
                    let armor = snapshot.iter().any(|other| {
                        other.owner == target.owner
                            && other.kind == "hq"
                            && other.research.iter().any(|item| item == "research_armor")
                    });
                    let hit = attack_damage(
                        &unit.kind,
                        &target.kind,
                        definition.damage + if has_tech("research_weapons") { 4 } else { 0 },
                    );
                    *damage.entry(target.id).or_default() +=
                        (hit - if armor { 3 } else { 0 }).max(1);
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
            if let Some(work) = construction.get(&unit.id) {
                let definition = stats(&unit.kind).unwrap();
                let before = unit.construction_remaining;
                unit.construction_remaining = before.saturating_sub(*work);
                let total = definition.hp - definition.hp / 10;
                let old_hp =
                    total as u64 * (definition.training_ticks - before) / definition.training_ticks;
                let new_hp = total as u64
                    * (definition.training_ticks - unit.construction_remaining)
                    / definition.training_ticks;
                unit.hp = (unit.hp + (new_hp - old_hp) as i32).min(definition.hp);
            }
            for (owner, research) in &discoveries {
                if unit.owner == *owner && unit.kind == "hq" && !unit.research.contains(research) {
                    unit.research.push(research.clone());
                }
            }
            unit.hp += repairs.get(&unit.id).copied().unwrap_or(0);
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
        for (owner, kind, x, y, rally) in births {
            if survivors.contains(&owner) {
                self.spawn(owner, &kind, x, y);
                let destination = if rally.kind == "rally_move" {
                    Some(Order {
                        kind: if is_army(&kind) {
                            "attack_move".into()
                        } else {
                            "move".into()
                        },
                        target: 0,
                        ..rally
                    })
                } else if rally.kind == "rally_gather" {
                    self.nodes
                        .iter()
                        .find(|node| node.id == rally.target && node.amount > 0)
                        .map(|node| Order {
                            kind: if kind == "worker" {
                                "gather".into()
                            } else {
                                "attack_move".into()
                            },
                            x: node.x,
                            y: node.y,
                            target: if kind == "worker" { node.id } else { 0 },
                        })
                } else {
                    None
                };
                if let Some(order) = destination {
                    self.units.last_mut().unwrap().order = order;
                }
            }
        }
        self.separate_units();
        for unit in &mut self.units {
            if !is_building(&unit.kind) && !navigation.free(unit.x, unit.y) {
                if let Some(old) = snapshot.iter().find(|old| old.id == unit.id) {
                    unit.x = old.x;
                    unit.y = old.y;
                }
            }
        }
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
            if is_building(&left.kind) {
                continue;
            }
            for right in right_slice {
                if is_building(&right.kind) {
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
                let left_held = left.order.kind == "hold";
                let right_held = right.order.kind == "hold";
                let left_push = if left_held {
                    0.0
                } else if right_held {
                    push * 2.0
                } else {
                    push
                };
                let right_push = if right_held {
                    0.0
                } else if left_held {
                    push * 2.0
                } else {
                    push
                };
                left.x = (left.x - normal_x * left_push).clamp(16.0, WORLD_SIZE - 16.0);
                left.y = (left.y - normal_y * left_push).clamp(16.0, WORLD_SIZE - 16.0);
                right.x = (right.x + normal_x * right_push).clamp(16.0, WORLD_SIZE - 16.0);
                right.y = (right.y + normal_y * right_push).clamp(16.0, WORLD_SIZE - 16.0);
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
    fn combined_arms_base_building_and_research_reach_victory() {
        let mut world = World::new(&[0, 1]);
        world.balances.insert(0, 3000);
        for (kind, x, y) in [
            ("barracks", 440.0, 220.0),
            ("factory", 220.0, 440.0),
            ("lab", 440.0, 440.0),
            ("outpost", 600.0, 220.0),
            ("turret", 220.0, 600.0),
        ] {
            let mut build = command(world.tick, 0, 2, &format!("build_{kind}"), 0);
            build.order.x = x;
            build.order.y = y;
            world.execute(&build).unwrap();
            for _ in 0..400 {
                world.step();
            }
            assert!(
                world
                    .units
                    .iter()
                    .any(|unit| unit.kind == kind && unit.construction_remaining == 0),
                "{kind} did not complete"
            );
        }
        let factory = world
            .units
            .iter()
            .find(|unit| unit.kind == "factory")
            .unwrap()
            .id;
        let barracks = world
            .units
            .iter()
            .find(|unit| unit.kind == "barracks")
            .unwrap()
            .id;
        let lab = world
            .units
            .iter()
            .find(|unit| unit.kind == "lab")
            .unwrap()
            .id;
        for kind in ["weapons", "armor", "logistics"] {
            world
                .execute(&command(world.tick, 0, lab, &format!("research_{kind}"), 0))
                .unwrap();
        }
        for _ in 0..3 {
            world
                .execute(&command(world.tick, 0, factory, "train_siege", 0))
                .unwrap();
            world
                .execute(&command(world.tick, 0, barracks, "train_soldier", 0))
                .unwrap();
        }
        for _ in 0..900 {
            world.step();
        }
        assert_eq!(world.units[0].research.len(), 3);
        assert_eq!(
            world
                .units
                .iter()
                .filter(|unit| unit.kind == "siege")
                .count(),
            3
        );
        world.spawn(1, "turret", 1250.0, 1380.0);
        world.spawn(1, "turret", 1380.0, 1250.0);
        let mut assault = command(world.tick, 0, 4, "attack_move", 0);
        assault.units = world
            .units
            .iter()
            .filter(|unit| unit.owner == 0 && is_army(&unit.kind))
            .map(|unit| unit.id)
            .collect();
        assault.order.x = 1300.0;
        assault.order.y = 1300.0;
        world.execute(&assault).unwrap();
        for _ in 0..5000 {
            world.step();
            if world.outcome.is_some() {
                break;
            }
        }
        assert_eq!(world.outcome, Some(0));
        assert!(world.units.iter().all(|unit| unit.owner == 0));
        assert_eq!(world.balances[&0], 825);
    }

    #[test]
    fn siege_repositions_when_cover_blocks_a_target_in_range() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "siege", 540.0, 680.0);
        let siege = world.next_id - 1;
        world.units[5].x = 740.0;
        world.units[5].y = 680.0;
        world.execute(&command(1, 0, siege, "attack", 6)).unwrap();
        for _ in 0..300 {
            world.step();
        }
        assert!(!world.units.iter().any(|unit| unit.id == 6));
        assert!(world.units.iter().find(|unit| unit.id == siege).unwrap().y != 680.0);
    }

    #[test]
    fn construction_requires_labor_can_resume_and_unlocks_units() {
        let mut world = World::new(&[0, 1]);
        world.balances.insert(0, 1000);
        let mut build = command(1, 0, 2, "build_barracks", 0);
        build.order.x = 440.0;
        build.order.y = 220.0;
        world.commands.push(build.clone());
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units.len(), 8);
        world.step();
        assert_eq!(world.balances[&0], 850);
        assert!(world.validate(&build).is_err());
        let site = world.next_id - 1;
        assert!(world
            .validate(&command(2, 0, site, "train_scout", 0))
            .is_err());
        world.execute(&command(3, 0, 2, "stop", 0)).unwrap();
        for _ in 0..200 {
            world.step();
        }
        assert!(
            world
                .units
                .iter()
                .find(|unit| unit.id == site)
                .unwrap()
                .construction_remaining
                > 0
        );
        world.execute(&command(4, 0, 2, "construct", site)).unwrap();
        for _ in 0..250 {
            world.step();
        }
        assert_eq!(
            world
                .units
                .iter()
                .find(|unit| unit.id == site)
                .unwrap()
                .construction_remaining,
            0
        );
        world
            .execute(&command(5, 0, site, "train_scout", 0))
            .unwrap();
        for _ in 0..70 {
            world.step();
        }
        assert!(world.units.iter().any(|unit| unit.kind == "scout"));
        assert_eq!(world.balances[&0], 770);
    }

    #[test]
    fn construction_refunds_once_and_research_is_unique_and_persistent() {
        let mut world = World::new(&[0, 1]);
        world.balances.insert(0, 1000);
        world.execute(&command(1, 0, 2, "build_lab", 0)).unwrap();
        let site = world.next_id - 1;
        world
            .execute(&command(2, 0, site, "cancel_construction", 0))
            .unwrap();
        assert_eq!(world.balances[&0], 950);
        assert!(world
            .execute(&command(3, 0, site, "cancel_construction", 0))
            .is_err());
        world.spawn(0, "lab", 440.0, 220.0);
        let lab = world.next_id - 1;
        world
            .execute(&command(4, 0, lab, "research_weapons", 0))
            .unwrap();
        assert!(world
            .validate(&command(5, 0, lab, "research_weapons", 0))
            .is_err());
        for _ in 0..300 {
            world.step();
        }
        assert!(world.units[0].research.contains(&"research_weapons".into()));
        assert!(world
            .validate(&command(6, 0, lab, "research_weapons", 0))
            .is_err());
        assert!(!world
            .units
            .iter()
            .any(|unit| unit.kind == "research_weapons"));
    }

    #[test]
    fn outposts_receive_cargo_and_turrets_fire_without_moving() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 600.0, 200.0);
        world.units[1].x = 650.0;
        world.units[1].y = 200.0;
        world.units[1].cargo = 25;
        world.units[1].order.kind = "return".into();
        world.spawn(0, "turret", 700.0, 200.0);
        world.units[5].x = 850.0;
        world.units[5].y = 200.0;
        for _ in 0..5 {
            world.step();
        }
        assert_eq!(world.balances[&0], 275);
        assert_eq!(world.units[5].hp, 44);
        assert_eq!(
            (world.units.last().unwrap().x, world.units.last().unwrap().y),
            (700.0, 200.0)
        );
    }

    #[test]
    fn attack_move_waits_engages_and_resumes_after_combat() {
        let mut world = World::new(&[0, 1]);
        world
            .units
            .retain(|unit| unit.kind == "hq" || unit.id == 4 || unit.id == 6);
        let enemy = world.units.iter_mut().find(|unit| unit.id == 6).unwrap();
        enemy.x = 430.0;
        enemy.y = 275.0;
        enemy.hp = 18;
        world.commands.push(command(1, 0, 4, "attack_move", 0));
        for _ in 0..19 {
            world.step();
        }
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!((soldier.x, soldier.y), (275.0, 275.0));
        world.step();
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!(soldier.order.target, 6);
        assert_eq!(soldier.y, 275.0);
        for _ in 0..120 {
            world.step();
        }
        assert!(!world.units.iter().any(|unit| unit.id == 6));
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!((soldier.x, soldier.y), (500.0, 500.0));
        assert_eq!(soldier.order.kind, "stop");
    }

    #[test]
    fn hold_fires_without_pursuit_or_collision_displacement() {
        let mut world = World::new(&[0, 1]);
        world.units[3].order.kind = "hold".into();
        world.units[1].x = 275.0;
        world.units[1].y = 275.0;
        world.units[5].x = 375.0;
        world.units[5].y = 275.0;
        world.step();
        assert_eq!((world.units[3].x, world.units[3].y), (275.0, 275.0));
        assert_eq!(world.units[5].hp, 42);
        world.units[5].x = 425.0;
        for _ in 0..20 {
            world.step();
        }
        assert_eq!((world.units[3].x, world.units[3].y), (275.0, 275.0));
        assert_eq!(world.units[5].hp, 42);
        assert!(world.validate(&command(1, 0, 2, "hold", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "attack_move", 0)).is_err());
    }

    #[test]
    fn rally_is_delayed_and_new_units_inherit_it_without_moving_hq() {
        let mut world = World::new(&[0, 1]);
        world.commands.push(command(1, 0, 1, "rally_gather", 1));
        world.commands.push(command(2, 0, 1, "train_worker", 0));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[0].order.kind, "stop");
        world.step();
        assert_eq!(world.units[0].order.kind, "rally_gather");
        for _ in 20..80 {
            world.step();
        }
        assert_eq!(world.units.last().unwrap().order.kind, "gather");
        assert_eq!(world.units.last().unwrap().order.target, 1);
        assert_eq!((world.units[0].x, world.units[0].y), (220.0, 220.0));
        let mut clear = command(3, 0, 1, "clear_rally", 0);
        clear.execute_tick = world.tick + 20;
        world.commands.push(clear);
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.units[0].order.kind, "stop");
    }

    #[test]
    fn cancel_refunds_only_unfinished_production_once_and_preserves_rally() {
        let mut world = World::new(&[0, 1]);
        world.commands.push(command(1, 0, 1, "train_worker", 0));
        world.commands.push(command(2, 0, 1, "train_soldier", 0));
        world.commands.push(command(3, 0, 1, "rally_move", 0));
        for _ in 0..80 {
            world.step();
        }
        assert_eq!(world.balances[&0], 100);
        let mut cancel = command(4, 0, 1, "cancel_production", 0);
        cancel.execute_tick = 100;
        world.commands.push(cancel.clone());
        cancel.id = 5;
        world.commands.push(cancel);
        for _ in 80..99 {
            world.step();
        }
        assert_eq!(world.balances[&0], 100);
        world.step();
        assert_eq!(world.balances[&0], 200);
        assert!(world.units[0].production.is_empty());
        assert_eq!(world.units[0].order.kind, "rally_move");
        assert_eq!(world.commands.last().unwrap().status, "rejected");
        assert_eq!(world.units.iter().filter(|unit| unit.owner == 0).count(), 5);
    }

    #[test]
    fn repair_waits_costs_ore_and_never_overheals_with_multiple_workers() {
        let mut world = World::new(&[0, 1]);
        world.units[0].hp = 1194;
        world.units[1].x = 250.0;
        world.units[2].y = 250.0;
        world.commands.push(command(1, 0, 2, "repair", 1));
        world.commands.push(command(2, 0, 3, "repair", 1));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[0].hp, 1194);
        assert_eq!(world.balances[&0], 250);
        world.step();
        assert_eq!(world.units[0].hp, 1200);
        assert_eq!(world.balances[&0], 248);
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.balances[&0], 248);
        assert!(world.validate(&command(3, 0, 2, "repair", 5)).is_err());
        assert!(world.validate(&command(3, 0, 4, "repair", 1)).is_err());
        assert!(world.validate(&command(3, 0, 2, "repair", 2)).is_err());
    }

    #[test]
    fn repairs_pause_without_funds_and_stop_when_target_disappears() {
        let mut world = World::new(&[0, 1]);
        world.units[3].hp = 100;
        world.units[1].x = 275.0;
        world.units[1].y = 250.0;
        world.balances.insert(0, 0);
        world.commands.push(command(1, 0, 2, "repair", 4));
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(world.units[3].hp, 100);
        assert_eq!(world.units[1].order.kind, "repair");
        world.balances.insert(0, 1);
        for _ in 0..10 {
            world.step();
        }
        assert_eq!(world.units[3].hp, 105);
        assert_eq!(world.balances[&0], 0);
        world.units.retain(|unit| unit.id != 4);
        world.step();
        assert_eq!(world.units[1].order.kind, "stop");
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
