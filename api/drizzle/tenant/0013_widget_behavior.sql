-- Page-targeting rules (#11) and proactive triggers (#12) for the widget.
-- Both mirror the theme's draft/published isolation: editors change the draft
-- in the dashboard and only a publish promotes it to the live, publicly-served
-- config. Defaults keep every existing config row at "show everywhere, no
-- proactive triggers" — i.e. exactly today's behavior.
ALTER TABLE widget_configs
  ADD COLUMN targeting_draft     jsonb NOT NULL DEFAULT '{"defaultShow":true,"rules":[]}',
  ADD COLUMN targeting_published jsonb,
  ADD COLUMN triggers_draft      jsonb NOT NULL DEFAULT '{"afterSeconds":null,"scrollDepth":null,"exitIntent":false}',
  ADD COLUMN triggers_published  jsonb;
