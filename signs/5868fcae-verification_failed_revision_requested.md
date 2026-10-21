---
trigger: "verification_failed_revision_requested"
observation: "npm run build exited 2. logs: verification/cmd-003.stdout.log verification/cmd-003.stderr.log. > metapoo-web@0.1.0 build\n> tsc --noEmit && vite build\nsrc/pages/wall/mount-wall.dispose.test.ts(227,5): error TS2349: This expression is not callable.\n  Type 'never' has no call signatures.\nsrc/pages/wall/mount-wall.dispose.test.ts(272,5): error TS2349: This expression is not callable.\n  Type 'never' has no call signatures."
status: proposed
---

ALWAYS record and address verification_failed_revision_requested: npm run build exited 2. logs: verification/cmd-003.stdout.log verification/cmd-003.stderr.log. > metapoo-web@0.1.0 build
> tsc --noEmit && vite build
src/pages/wall/mount-wall.dispose.test.ts(227,5): error TS2349: This expression is not callable.
  Type 'never' has no call signatures.
src/pages/wall/mount-wall.dispose.test.ts(272,5): error TS2349: This expression is not callable.
  Type 'never' has no call signatures.
