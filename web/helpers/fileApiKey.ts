// Side-effect module: registers the FileFolderAPI key. BulkDatabase2 (used for
// the activity-thumbnail cache) refuses to touch the file system until
// setFileAPIKey has been called, so this must run BEFORE any module that uses
// BulkDatabase2. ES module bodies execute in import order, so browser.tsx
// imports THIS first (its body runs before the other imports' bodies).

import { setFileAPIKey } from "sliftutils/storage/FileFolderAPI";

setFileAPIKey("mydoorcamera");
