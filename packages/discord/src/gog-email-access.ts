function getCommandHead(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
}

export function isReadOnlyGogEmailCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return (
    (
      head[0] === "gmail"
      && head[1] === "messages"
      && ["search", "list", "get", "read"].includes(head[2] ?? "")
    )
    || (
      head[0] === "gmail"
      && ["get", "read", "attachment"].includes(head[1] ?? "")
    )
    || (head[0] === "gmail" && head[1] === "thread" && head[2] !== "modify")
  );
}
