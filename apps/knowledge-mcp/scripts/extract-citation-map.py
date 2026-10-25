import json
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd


def read_request() -> dict:
    payload = json.load(sys.stdin)
    if not isinstance(payload.get("manifest"), list) or not payload["manifest"]:
        raise ValueError("manifest must contain at least one entry")
    return payload


def run(payload: dict) -> list[dict]:
    data = Path(payload["data"]).resolve(strict=True)
    documents = pd.read_parquet(data / "documents.parquet")
    text_units = pd.read_parquet(data / "text_units.parquet")
    entities = pd.read_parquet(data / "entities.parquet")
    manifest = {entry["documentTitle"]: entry for entry in payload["manifest"]}
    if len(manifest) != len(payload["manifest"]):
        raise ValueError("manifest documentTitle values must be unique")

    document_titles = set(str(title) for title in documents["title"].tolist())
    manifest_titles = set(manifest)
    if document_titles != manifest_titles:
        missing = sorted(document_titles - manifest_titles)
        extra = sorted(manifest_titles - document_titles)
        raise ValueError(f"manifest mismatch; unmapped documents={missing}; missing documents={extra}")

    text_by_id = {str(row.id): str(row.text) for row in text_units.itertuples()}
    entities_by_text_unit = defaultdict(list)
    for row in entities.itertuples():
        for text_unit_id in list_value(getattr(row, "text_unit_ids", [])):
            entities_by_text_unit[str(text_unit_id)].append(str(row.title))

    rows = []
    for document in documents.itertuples():
        entry = manifest[str(document.title)]
        for text_unit_id in list_value(document.text_unit_ids):
            text_unit_id = str(text_unit_id)
            excerpt = text_by_id.get(text_unit_id)
            if excerpt is None:
                raise ValueError(f"document references unknown text unit {text_unit_id}")
            rows.append({
                "textUnitId": text_unit_id,
                "sourceId": entry["sourceId"],
                "locator": entry["locator"],
                "excerpt": excerpt[:2000],
                "relatedEntities": list(dict.fromkeys(entities_by_text_unit[text_unit_id])),
            })
    if not rows:
        raise ValueError("GraphRAG index did not produce any text units")
    return rows


def list_value(value) -> list:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


if __name__ == "__main__":
    try:
        print(json.dumps(run(read_request()), ensure_ascii=False))
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
