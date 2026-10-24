# Sentinel Operations Runbook

## Deployment sequence

1. Back up the application database using the organization-approved database process.
2. Deploy the application files.
3. Apply additive schema migrations:

   ```powershell
   npm.cmd run migrate
   ```

4. Verify the installed Sentinel schema:

   ```powershell
   npm.cmd run sentinel:preflight
   ```

5. Start or restart the application using the normal service manager.
6. Sign in as an administrator and open **Sentinel → Overview**.
7. Confirm Control Health reports the required schema as healthy.
8. Run **Daily Protections** once and review every exception.
9. Generate the Daily SOC report and retain it through the approved reporting workflow.

The preflight command reports table, column, index, installation-marker, schema-version, and legacy-status readiness. It never prints database passwords or connection strings.

## First-day validation

- Confirm API and Authentication telemetry update within 15 minutes.
- Confirm a Daily Protection routine completes and is not reused unexpectedly.
- Confirm Review shows owners, SLA deadlines, disposition, resolution, and validation state.
- Confirm Investigate can pivot from an IP or identity to a correlated timeline.
- Confirm Purple Team Validation accepts a pending observation and evaluates it.
- Confirm Retention displays a preview. Do not execute retention merely as a deployment test.
- Confirm forensic evidence remains redacted by default and root-gated when revealed.

## Daily analyst routine

1. Read Control Health and resolve critical checks first.
2. Run Daily Protections or confirm the UTC-day run already completed.
3. Review critical, reopened, breached, and unassigned cases.
4. Assign owners and document triage decisions.
5. Investigate correlated traffic and authentication behavior.
6. Contain confirmed threats.
7. Resolve only with disposition and resolution summary.
8. Close only after recording validation.
9. Evaluate due Purple Team observations.
10. Generate and copy the shift-handoff report.

## Retention boundary

Retention is preview-first and root-only. Execution requires the exact phrase shown in the Retention UI. Threat cases, analyst notes, lifecycle history, case actions, and forensic-access audit metadata are preserved by this workflow.

## Rollback boundary

The schema migration is additive. Application rollback may restore the prior application release while leaving new tables and columns in place. Do not manually drop Sentinel tables during an application rollback. Any database restoration must follow the approved backup and incident-change process.

## Operational commands

```powershell
npm.cmd test
npm.cmd run migrate
npm.cmd run sentinel:preflight
```

## Controlled operator credential recovery

When an operator cannot authenticate and therefore cannot obtain an operator session,
use the server-side recovery command from a protected interactive terminal. It verifies
that exactly one Legacy user matches, reads the new password without echoing it, stores
only bcrypt, and writes the reset to `api_login_events` in the same transaction.

```powershell
npm.cmd run user:set-password -- --location LOCATION_ID --username USERNAME
```

Never pass the password as a command-line argument or edit `users.passwordHash` manually.

Sentinel reports authentication as degraded until every credential-bearing user is bcrypt-managed. Audit progress without selecting credential values:

```sql
SELECT COUNT(*) AS total_users,
       SUM(passwordHash LIKE '$2%') AS bcrypt_users,
       SUM(passwordHash IS NOT NULL AND passwordHash <> '' AND passwordHash NOT LIKE '$2%') AS legacy_hash_users,
       SUM(passwordHash IS NULL OR passwordHash = '') AS missing_credentials
FROM users;
```

Reset each legacy user individually with the protected command above. A legacy client hash cannot be converted into bcrypt without choosing a new plaintext password.

Run the full test suite before deployment. Run migration and preflight against the intended environment using its existing protected `.env` configuration.
