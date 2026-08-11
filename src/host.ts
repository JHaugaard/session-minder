// src/host.ts
// Extracted from routes/attach.ts so the list route answers "is this row
// foreign?" with the exact same rule the attach route degrades on. Two copies
// of this function would be two chances to disagree — and a disagreement here
// shows John an unmarked row that then refuses to attach.
import { hostname } from 'node:os';

// The hooks record `host` as the Tailscale short name (vps8-core), not the
// provider hostname (srv1086450), so the comparison must use the same name.
// SESSION_MINDER_HOST_NAME is set in the systemd unit; hostname() is only a
// last-resort fallback and will simply degrade if it disagrees.
export function localHost(): string {
  // `||`, not `??`: .env.example sets values empty by convention, and a blank
  // SESSION_MINDER_HOST_NAME= would make `??` return '' (an empty string is
  // not nullish), so every attach would degrade with foreign_host.
  return process.env.SESSION_MINDER_HOST_NAME || hostname();
}
