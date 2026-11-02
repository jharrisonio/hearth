export function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function ownerKey(type: "user" | "bot", id: string) {
  return `${type}:${id}`;
}

export function parseOwnerKey(value: string): { type: "user" | "bot"; id: string } | null {
  const [type, id] = value.split(":");
  if ((type !== "user" && type !== "bot") || !id) return null;
  return { type, id };
}
