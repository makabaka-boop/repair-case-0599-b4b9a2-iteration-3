/** 与后端一致的字段约束：L* 闭区间 [0,100]，a 与 b 轴闭区间 [-128,127]。 */
export const COMPONENT_BOUNDS = {
  L: { min: 0, max: 100, label: "L*", greek: "L*" },
  a: { min: -128, max: 127, label: "a*", greek: "a*" },
  b: { min: -128, max: 127, label: "b*", greek: "b*" },
} as const;

export type ComponentKey = keyof typeof COMPONENT_BOUNDS;
export type ColorKey = "standard" | "sample";

export interface LabInput {
  L: string;
  a: string;
  b: string;
}

export type LabForm = Record<ColorKey, LabInput>;

export interface FieldError {
  field: string;
  message: string;
}

export interface DeltaEResult {
  delta_e00: number;
  delta_e00_round: number;
  threshold: number;
  passed: boolean;
  excess_raw: number;
  excess_round: number;
  relation: "<=" | ">";
}

export interface DeltaESuccessResponse {
  ok: true;
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  result: DeltaEResult;
}

export interface DeltaEErrorResponse {
  ok: false;
  message: string;
  errors: FieldError[];
}

/* ── GS1 批次标签核验 ─────────────────────────────────────────────── */

/** 统一批次信息：商品编码、批号、失效日期（ISO 日历日期）。 */
export interface Gs1BatchInfo {
  gtin: string;
  lot: string;
  expires: string;
}

export interface Gs1ParsedField {
  ai: string;
  label: string;
  value: string;
  position: number;
}

export type Gs1LabelFormat = "readable" | "scan";

export interface Gs1LabelSuccessResponse {
  ok: true;
  format: Gs1LabelFormat;
  fields: Gs1ParsedField[];
  batch: Gs1BatchInfo;
}

export interface Gs1LabelErrorResponse {
  ok: false;
  message: string;
  errors: FieldError[];
  /** 机器可读错误代码：parse_error / unsupported_character / invalid_checksum / invalid_date / missing_field / duplicate_field / empty_label */
  code?: string;
  /** 首个无法解析的字符在原文中的下标（0 起）；无法定位时为 null */
  position: number | null;
}

export const THRESHOLD = 2.0;
export const EMPTY_FORM: LabForm = {
  standard: { L: "", a: "", b: "" },
  sample: { L: "", a: "", b: "" },
};
