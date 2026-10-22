/**
 * What `expo-sqlite` resolves to while a page is rendered on the server.
 *
 * `metro.config.js` substitutes it for the server environments: the driver's
 * web build registers a Worker chunk Metro never emits for a server bundle, and
 * a server render has no OPFS, origin or user to open a database with. Each
 * export throws, so a render that reaches the database fails at the call; the
 * listener returns a removable handle, since a mount-time subscription must
 * unsubscribe. Nothing imports this file (Metro's resolver hands it back for
 * the package name), which is why `knip.json` ignores it by path.
 */

function unavailable(name) {
  return () => {
    throw new Error(
      `expo-sqlite.${name} was called during server rendering, where there is no database. ` +
        "A screen is reading data before the database gate.",
    );
  };
}

export const openDatabaseAsync = unavailable("openDatabaseAsync");
export const deleteDatabaseAsync = unavailable("deleteDatabaseAsync");

export function addDatabaseChangeListener() {
  return { remove() {} };
}
