# Background error triage

Sentry is the platform error destination for terminal hosted review failures and repository indexing failures. Existing organization Slack notifications are unchanged.

In the Octopus Sentry project, filter Issues by:

```text
environment:production error_boundary:background -synthetic:true is:unresolved
```

Check new and regressed issues daily. Start with recurring failures that affect reviews. Each event includes failure stage, ownership (`platform` or `unknown`), provider, a safe code, and attempt/PR identifiers in its context. Use the attempt ID to correlate with authenticated Review Logs. Link the fix and verify the deployed version before resolving the issue. Unknown means the available evidence does not establish the cause; it is not a confirmed provider outage.

Expected credit/spend blocks, known BYOK authentication/quota failures and cancelled reviews and cancelled/replaced index work do not create platform incidents. Existing queue retries report only at exhaustion. Handled review failures are already terminal and report immediately; adding automatic provider retries is tracked separately in #945. This does not claim every swallowed exception elsewhere in the application is covered. Local CLI uploads and community/legacy large-review pipelines are outside this change.

After a release, an operator can run `node apps/web/sentry-smoke.mjs --send-synthetic` inside one review-worker container with its existing Sentry configuration. It sends one labelled synthetic event through the shared reporting helper and prints its event ID and release. Verify that event in Sentry, including its release, stage and safe context, then resolve the separately grouped synthetic issue (`synthetic:true`). A successful flush alone does not prove receipt. This check never calls a model or changes customer data, and is not exposed as a web endpoint. Self-hosted deployments remain opt-in through their existing DSN configuration.
