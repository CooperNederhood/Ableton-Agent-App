export interface OrderedRecord {
  readonly id: string;
  readonly createdAt?: string;
  readonly decidedAt?: string;
}

export type OrderedField = "createdAt" | "decidedAt";

export function compareOrderedRecords(
  field: OrderedField = "createdAt",
): (left: OrderedRecord, right: OrderedRecord) => number {
  return (left, right) => {
    const leftValue = left[field] ?? "";
    const rightValue = right[field] ?? "";
    return (
      leftValue.localeCompare(rightValue) || left.id.localeCompare(right.id)
    );
  };
}

export function comparePreferenceKeys(
  left: { readonly key: string },
  right: { readonly key: string },
): number {
  return left.key.localeCompare(right.key);
}
