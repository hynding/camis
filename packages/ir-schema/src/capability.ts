import type { FieldType, RelationKind } from "./fields";
import type { IrErrorLocation } from "./errors";

export interface CapabilityDescriptor {
  target: string;
  fieldTypes: Partial<Record<FieldType, boolean>>;
  relationKinds: Partial<Record<RelationKind, boolean>>;
  features: Partial<
    Record<"dynamicZone" | "component" | "softDelete" | "draftPublish" | "media", boolean>
  >;
}

export interface CapabilityGap {
  feature: string;
  location: IrErrorLocation;
  severity: "error" | "downgrade";
  message: string;
}

export interface CapabilityGapReport {
  target: string;
  gaps: CapabilityGap[];
}
