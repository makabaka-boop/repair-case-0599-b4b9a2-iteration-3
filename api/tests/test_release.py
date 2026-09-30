"""批次放行单 /api/batch-release 测试：组合裁决、失败三分类与字段身份快照。"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.main import app
from app.release import evaluate_batch_release, make_release_number

client = TestClient(app)

# Sharma 参考对 #25：ΔE00 ≈ 1.2644（放行）
PASS_STD = {"L": 60.2574, "a": -34.0099, "b": 36.2677}
PASS_SMP = {"L": 60.4626, "a": -34.1751, "b": 39.4387}
# Sharma 参考对 #1：ΔE00 ≈ 2.0425（超差）
FAIL_STD = {"L": 50.0, "a": 2.6772, "b": -79.7751}
FAIL_SMP = {"L": 50.0, "a": 0.0, "b": -82.7485}

LABEL_OK = "(01)09506000134352(10)INK2407(17)280930"
LABEL_BAD_CHECK = "(01)09506000134353(10)INK2407(17)280930"
LABEL_SCAN_OK = "010950600013435210INK2407\x1d17280930"


def _post(standard: dict[str, float], sample: dict[str, float], raw: str) -> object:
    return client.post(
        "/api/batch-release",
        json={"standard": standard, "sample": sample, "raw_label": raw},
    )


# ── 两项都过：生成放行单，且字段身份逐字符/逐数值固定 ───────────────────

def test_pass_color_and_valid_label_releases_note() -> None:
    res = _post(PASS_STD, PASS_SMP, LABEL_OK)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["color"]["passed"] is True
    assert body["color"]["result"]["passed"] is True
    assert body["label"]["valid"] is True
    assert body["label"]["error"] is None
    assert body["label"]["batch"] == {
        "gtin": "09506000134352",
        "lot": "INK2407",
        "expires": "2028-09-30",
    }
    assert body["released"] is True
    note = body["release"]
    assert note is not None
    assert re.fullmatch(r"BR-\d{8}-[0-9A-F]{8}", note["number"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", note["issued_at"])
    assert note["batch"] == body["label"]["batch"]
    assert note["color"]["passed"] is True


def test_scan_format_label_is_accepted_and_reported() -> None:
    res = _post(PASS_STD, PASS_SMP, LABEL_SCAN_OK)
    body = res.json()
    assert res.status_code == 200
    assert body["label"]["valid"] is True
    assert body["label"]["format"] == "scan"
    assert body["released"] is True


def test_snapshot_pins_exact_inputs_including_trailing_space() -> None:
    raw = "(01)09506000134352(10)INK2407 (17)280930"  # 批号带尾随空格
    res = _post(PASS_STD, PASS_SMP, raw)
    body = res.json()
    assert body["released"] is True
    # 顶层快照逐数值、逐字符固定
    assert body["snapshot"]["standard"] == PASS_STD
    assert body["snapshot"]["sample"] == PASS_SMP
    assert body["snapshot"]["raw_label"] == raw
    # 放行单内嵌同一份快照（字段身份：凭据固定于这次请求）
    note = body["release"]
    assert note["raw_label"] == raw
    assert note["standard"] == PASS_STD
    assert note["sample"] == PASS_SMP
    # 尾随空格逐字符保留，批号身份不同
    assert note["batch"]["lot"] == "INK2407 "


def test_trailing_space_lots_are_distinct_identities() -> None:
    r1 = _post(PASS_STD, PASS_SMP, "(01)09506000134352(10)INK2407(17)280930").json()
    r2 = _post(PASS_STD, PASS_SMP, "(01)09506000134352(10)INK2407 (17)280930").json()
    assert r1["release"]["batch"]["lot"] == "INK2407"
    assert r2["release"]["batch"]["lot"] == "INK2407 "
    assert r1["release"]["batch"]["lot"] != r2["release"]["batch"]["lot"]
    assert r1["release"]["raw_label"] != r2["release"]["raw_label"]


def test_release_numbers_are_unique_per_request() -> None:
    nums = {_post(PASS_STD, PASS_SMP, LABEL_OK).json()["release"]["number"]
            for _ in range(5)}
    assert len(nums) == 5


def test_make_release_number_format() -> None:
    n1, n2 = make_release_number(), make_release_number()
    assert re.fullmatch(r"BR-\d{8}-[0-9A-F]{8}", n1)
    assert n1 != n2


def test_release_uses_unrounded_threshold_for_gate() -> None:
    """显示 2.00 但未舍入 1.997x 的边界对仍须放行（复用 judge 的同一规则）。"""
    res = _post(
        {"L": 50.0, "a": 0.0, "b": 0.0},
        {"L": 52.004, "a": 0.0, "b": 0.0},
        LABEL_OK,
    )
    body = res.json()
    assert body["color"]["result"]["delta_e00"] < 2.0
    assert body["color"]["result"]["delta_e00_round"] == 2.0
    assert body["released"] is True
    assert body["release"] is not None


# ── 单一核验失败：HTTP 200 的业务裁决，released=False，不生成半张凭据 ─────

def test_color_pass_but_label_invalid_is_not_released_but_color_verdict_present() -> None:
    res = _post(PASS_STD, PASS_SMP, LABEL_BAD_CHECK)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True  # 请求被处理，业务裁决在字段里区分
    assert body["color"]["passed"] is True  # 色差结论仍然返回
    assert body["label"]["valid"] is False
    assert body["label"]["batch"] is None
    err = body["label"]["error"]
    assert err["code"] == "invalid_checksum"
    assert err["position"] == 17  # 校验位下标（0 起）
    assert body["released"] is False
    assert body["release"] is None  # 绝不生成半张凭据


def test_color_fail_but_label_valid_is_not_released_but_batch_present() -> None:
    res = _post(FAIL_STD, FAIL_SMP, LABEL_OK)
    assert res.status_code == 200
    body = res.json()
    assert body["color"]["passed"] is False
    assert body["color"]["result"]["relation"] == ">"
    assert body["color"]["result"]["delta_e00_round"] == 2.04
    assert body["label"]["valid"] is True
    assert body["label"]["batch"]["lot"] == "INK2407"
    assert body["released"] is False
    assert body["release"] is None


def test_both_checks_fail_reports_both_reasons() -> None:
    body = _post(FAIL_STD, FAIL_SMP, LABEL_BAD_CHECK).json()
    assert body["color"]["passed"] is False
    assert body["label"]["valid"] is False
    assert body["label"]["error"]["code"] == "invalid_checksum"
    assert body["released"] is False
    assert body["release"] is None


def test_label_parse_error_keeps_color_check_independent() -> None:
    """标签无法解析（缺 AI、字符集外字符）不影响同次色差核验照常完成。"""
    body = _post(PASS_STD, PASS_SMP, "(01)09506000134352(10)INK2407").json()
    assert body["color"]["passed"] is True
    assert body["label"]["valid"] is False
    assert body["label"]["error"]["code"] == "missing_field"
    assert body["released"] is False


def test_unsupported_character_is_business_failure_with_position() -> None:
    raw = "(01)09506000134352(17)280930(10)AB\tCD"
    body = _post(PASS_STD, PASS_SMP, raw).json()
    assert body["label"]["valid"] is False
    assert body["label"]["error"]["code"] == "unsupported_character"
    assert raw[body["label"]["error"]["position"]] == "\t"
    # 原始输入快照仍逐字符保留（供前端高亮），但不产生凭据
    assert body["snapshot"]["raw_label"] == raw
    assert body["release"] is None


# ── 请求结构非法：整次拒绝 422，与业务失败/网络异常明确区分 ────────────

def test_lab_out_of_range_is_422_without_any_verdict() -> None:
    res = client.post(
        "/api/batch-release",
        json={
            "standard": PASS_STD,
            "sample": {"L": 50.0, "a": 0.0, "b": 9999.0},
            "raw_label": LABEL_OK,
        },
    )
    assert res.status_code == 422
    body = res.json()
    assert body["ok"] is False
    assert any(e["field"] == "sample.b" for e in body["errors"])
    # 422 响应不含任何核验结果或凭据字段（不能出现半张凭据）
    assert "release" not in body
    assert "released" not in body


def test_missing_color_and_empty_label_are_422() -> None:
    res = client.post(
        "/api/batch-release",
        json={"standard": PASS_STD, "sample": PASS_SMP, "raw_label": ""},
    )
    assert res.status_code == 422
    assert any(e["field"] == "raw_label" for e in res.json()["errors"])

    res = client.post(
        "/api/batch-release",
        json={"sample": PASS_SMP, "raw_label": LABEL_OK},
    )
    assert res.status_code == 422


def test_non_finite_and_extra_fields_are_422() -> None:
    res = client.post(
        "/api/batch-release",
        json={"standard": PASS_STD, "sample": PASS_SMP, "raw_label": LABEL_OK, "x": 1},
    )
    assert res.status_code == 422

    res = client.post(
        "/api/batch-release",
        content=(
            b'{"standard":{"L":50,"a":0,"b":0},'
            b'"sample":{"L":50,"a":0,"b":1e999},'
            b'"raw_label":"' + LABEL_OK.encode() + b'"}'
        ),
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 422
    assert any(e["field"] == "sample.b" for e in res.json()["errors"])


# ── 直接单元测试组合函数：复用既有判定/解析路径 ─────────────────────────

def test_evaluate_function_pins_tuple_inputs() -> None:
    out = evaluate_batch_release(
        standard=(60.2574, -34.0099, 36.2677),
        sample=(60.4626, -34.1751, 39.4387),
        raw_label=LABEL_OK,
    )
    assert out["released"] is True
    assert out["snapshot"]["standard"] == {"L": 60.2574, "a": -34.0099, "b": 36.2677}
    assert out["release"]["number"].startswith("BR-")


def test_evaluate_function_failure_shape_has_no_note() -> None:
    out = evaluate_batch_release(
        standard=(50.0, 2.6772, -79.7751),
        sample=(50.0, 0.0, -82.7485),
        raw_label="garbage",
    )
    assert out["ok"] is True
    assert out["released"] is False
    assert out["release"] is None
    assert out["color"]["passed"] is False
    assert out["label"]["valid"] is False
