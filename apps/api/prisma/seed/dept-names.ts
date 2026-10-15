// The "Account Management" department is now called "Client Management". Databases seeded before the rename still
// have the old name, so the seed treats the two names as the same department when it looks one up.
const OLD_NAMES: Record<string, string> = { 'Account Management': 'Client Management' };

const current = (name: string) => OLD_NAMES[name] ?? name;

/** True when two department names mean the same department (old and new names count as equal). */
export const sameDept = (a: string, b: string) => current(a) === current(b);

/** Every name a department may be stored under: the new name plus any old ones. */
export const deptNames = (name: string) => {
  const now = current(name);
  return [now, ...Object.keys(OLD_NAMES).filter((old) => OLD_NAMES[old] === now)];
};
