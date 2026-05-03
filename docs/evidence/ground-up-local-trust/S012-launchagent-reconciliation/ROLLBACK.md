# S012 LaunchAgent Rollback

Disabled at: `20260430-215056`

Backup directory:

```text
/Users/umasankr/Library/LaunchAgents/.ping-mem-backups/20260430-215056
```

Disabled directory:

```text
/Users/umasankr/Library/LaunchAgents/.ping-mem-disabled-20260430-215056
```

To restore the previous machine-local LaunchAgents:

```bash
uid=$(id -u)
base=/Users/umasankr/Library/LaunchAgents
disabled="$base/.ping-mem-disabled-20260430-215056"
for plist in "$disabled"/com.ping-mem*.plist; do
  mv "$plist" "$base/"
  launchctl bootstrap "gui/$uid" "$base/$(basename "$plist")"
done
```

No secrets are recorded in this rollback note. The disabled plists retain their original local values on disk.
