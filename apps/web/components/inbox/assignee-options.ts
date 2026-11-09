import type { UserRole } from '@dezon/shared';

export interface AssigneeOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Person {
  id: string;
  name: string;
}

/**
 * Lựa chọn người phụ trách theo quyền (khớp luật ở core):
 * - admin: phân công cho bất kỳ ai trong danh bạ;
 * - agent: chỉ nhận hội thoại về mình hoặc bỏ nhận hội thoại của mình.
 */
export function assigneeOptions({
  viewer,
  assigned,
  directory,
}: {
  viewer: (Person & { role: UserRole }) | null;
  assigned: Person | null;
  directory: readonly Person[];
}): AssigneeOption[] {
  const label = (p: Person) => (p.id === viewer?.id ? `${p.name} (tôi)` : p.name);

  if (viewer && viewer.role !== 'admin') {
    const assignedToOther = !!assigned && assigned.id !== viewer.id;
    const options: AssigneeOption[] = [
      // Bỏ nhận chỉ được khi hội thoại đang là của mình (hoặc vốn chưa phân công).
      { value: '', label: 'Chưa phân công', disabled: assignedToOther },
      { value: viewer.id, label: label(viewer) },
    ];
    // Giữ người đang phụ trách để ô chọn hiển thị đúng giá trị hiện tại.
    if (assigned && assignedToOther)
      options.push({ value: assigned.id, label: assigned.name, disabled: true });
    return options;
  }

  // Danh bạ chưa tải được: vẫn hiện người đang phụ trách và chính mình.
  const people = new Map<string, string>();
  for (const u of directory) people.set(u.id, u.name);
  if (assigned) people.set(assigned.id, assigned.name);
  if (viewer && !people.has(viewer.id)) people.set(viewer.id, viewer.name);
  return [
    { value: '', label: 'Chưa phân công' },
    ...[...people].map(([id, name]) => ({ value: id, label: label({ id, name }) })),
  ];
}
