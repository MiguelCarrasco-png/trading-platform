-- Record which algorithm VERSION each saved config version was written for.
--
-- strategy_versions holds immutable config snapshots, but nothing said which
-- code those configs were written against. A config saved under algorithm v1
-- can be invalid or behave differently under v2 (a new required field, a
-- changed meaning), and a run always executes the CURRENT algorithm, never the
-- one a version was written for. Recording it lets the UI warn "this version
-- predates the current algorithm" instead of letting it fail or surprise at start.
--
-- algorithm_version is NULL for rows saved before this migration: unknown, not zero.
--
-- save_strategy_version gains a sixth argument. The five-argument function is
-- dropped first: keeping both would make a five-argument call ambiguous once the
-- new one has a default. The default (NULL) keeps a not-yet-updated backend
-- working against the migrated database, so APPLY THIS MIGRATION BEFORE
-- DEPLOYING THE BACKEND THAT PASSES THE ARGUMENT (the reverse order fails: the
-- old database has no such parameter).

alter table strategy_versions add column algorithm_version integer;

comment on column strategy_versions.algorithm_version is
  'Strategy class VERSION current when this config version was saved; NULL = saved before this was recorded';

drop function save_strategy_version(uuid, text, jsonb, text, uuid);

-- Save the mutable latest-config pointer and its immutable audit version in one
-- database transaction. Serializing on the strategies row also makes the
-- per-strategy version-number trigger safe when two edits arrive together.
create function save_strategy_version(
  p_strategy uuid,
  p_name text,
  p_config jsonb,
  p_change_summary text,
  p_created_by uuid,
  p_algorithm_version integer default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  saved strategy_versions;
  attached_proposal uuid;
begin
  perform 1 from strategies where id = p_strategy for update;
  if not found then
    raise exception 'Strategy % not found', p_strategy;
  end if;

  update strategies
     set name = p_name, config = p_config, updated_at = now()
   where id = p_strategy;

  insert into strategy_versions (strategy_id, config, change_summary, created_by, algorithm_version)
  values (p_strategy, p_config, p_change_summary, p_created_by, p_algorithm_version)
  returning * into saved;

  update strategy_proposals
     set head_version_id = saved.id, updated_at = now()
   where id = (
     select id from strategy_proposals
      where strategy_id = p_strategy and status = 'open'
      limit 1
      for update)
  returning id into attached_proposal;

  return to_jsonb(saved) || jsonb_build_object('attached_to_proposal_id', attached_proposal);
end;
$$;

revoke execute on function save_strategy_version(uuid, text, jsonb, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function save_strategy_version(uuid, text, jsonb, text, uuid, integer)
  to service_role;
