export { fail, ok } from "./errors";
export type { IrError, IrErrorCode, IrErrorLocation, Result } from "./errors";
export {
  FIELD_TYPES,
  RELATION_KINDS,
  componentField,
  field,
  fieldApiName,
  inverseApiName,
} from "./fields";
export type { ComponentFieldT, Field, FieldType, RelationKind } from "./fields";
export { component, contentType, irDocument, isPublicApiAction, servesApiAction } from "./document";
export type { Component, ContentType, IrDocument } from "./document";
export { parseDocument } from "./parse";
export type { CapabilityDescriptor, CapabilityGap, CapabilityGapReport } from "./capability";
export { apiName, collectionName, fieldName, typeName } from "./identifiers";
export {
  HOOK_SCALARS,
  HOOK_TRIGGERS,
  LIFECYCLE_TRIGGERS,
  ENDPOINT_METHODS,
  ROUTE_ACTIONS,
  WRITING_TRIGGERS,
  endpoint,
  hook,
  routeHook,
  schedule,
  shapeField,
} from "./hooks";
export type {
  Endpoint,
  EndpointMethod,
  Hook,
  HookScalar,
  HookTrigger,
  RouteAction,
  RouteHook,
  Schedule,
  ShapeField,
} from "./hooks";
export { ai, aiPlaceholders, AI_TRIGGERS } from "./ai";
export type { Ai, AiTrigger } from "./ai";
