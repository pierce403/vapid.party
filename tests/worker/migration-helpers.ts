/**
 * Split the repository's ordered D1 migrations without breaking SQLite
 * trigger bodies at their internal semicolons.
 */
export function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;

  for (const sourceLine of sql.split('\n')) {
    const line = sourceLine.replace(/--.*$/, '');
    if (!current && !line.trim()) continue;
    current += `${line}\n`;

    if (!inTrigger && /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(current)) {
      inTrigger = true;
    }

    const trimmed = line.trim();
    if ((inTrigger && /^END;\s*$/i.test(trimmed)) || (!inTrigger && /;\s*$/.test(trimmed))) {
      statements.push(current.trim());
      current = '';
      inTrigger = false;
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
