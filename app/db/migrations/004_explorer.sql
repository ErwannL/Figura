-- Explorer runs (docs/EXPLORATEUR.md): live progress while running, and one active exploration
-- per target (a second one is refused with 409 EXPLORATION_ACTIVE).
alter table runs add column progress jsonb;
create unique index runs_one_exploration_per_target on runs ((coalesce(config->>'target', target_url)))
  where kind = 'explore' and status in ('draft', 'queued', 'preparing', 'running', 'reporting', 'cleaning');
