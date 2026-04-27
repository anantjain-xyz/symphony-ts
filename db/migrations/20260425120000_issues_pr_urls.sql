-- issues.pr_urls: GitHub PR URLs auto-attached to the Linear issue by Linear's
-- GitHub integration. Surfaced on the dashboard's session and issue pages so
-- operators can jump straight from an attempt to its open PR(s).

alter table issues
  add column pr_urls text[] not null default '{}';
