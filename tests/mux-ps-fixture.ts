export function muxPsFixture(table: string, args: readonly string[]): string {
  const rows = table.trim().split("\n");
  const links = args.at(-1) === "pid=,ppid=";
  const selected =
    args[0] === "-axo"
      ? rows
      : rows.filter((row) => args[1]?.split(",").includes(row.split(" ")[0]!));
  return (
    selected
      .map((row) => (links ? row.split(" ").slice(0, 2).join(" ") : row))
      .join("\n") + "\n"
  );
}
