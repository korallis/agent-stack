### Security
- Local CI runners: the job-started hook refuses fork code before any step runs. That covers a pull request from
  another repository, and a `workflow_run` started by one. It fails closed when the event or repository can't be read.
  The workflows' `runs-on` fork guard is routing only, because a PR runs its own copy of the workflow and a fork can
  edit it.
