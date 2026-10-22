// Upstream fixes applied to installed dependencies on every install. A dependency whose text no longer matches
// fails the install: check whether it is still needed, then drop or redo the patch.
import { readFileSync, writeFileSync } from "node:fs";

const PATCHES = [
  {
    // expo-sqlite keeps every web database in one OPFS folder and holds an exclusive handle on each file, so two apps
    // on one origin lock each other out. An own folder ends that; renaming it later would orphan existing web databases.
    file: "node_modules/expo-sqlite/web/worker.ts",
    edits: [["const VFS_NAME_PERSISTENT = 'expo-sqlite';", "const VFS_NAME_PERSISTENT = 'fiala-sqlite';"]],
  },
];

for (const { file, edits } of PATCHES) {
  let text = readFileSync(file, "utf8");
  if (edits.every(([, after]) => text.includes(after))) continue;
  for (const [before, after] of edits) {
    if (text.split(before).length !== 2) throw new Error(`${file} no longer matches its patch; check whether it is still needed.`);
    text = text.replace(before, after);
  }
  writeFileSync(file, text);
}
