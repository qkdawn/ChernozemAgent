import asyncio
import json
import sys
from pathlib import Path

import pandas as pd

import graphrag.api as api
from graphrag.config.load_config import load_config


def read_request() -> dict:
    payload = json.load(sys.stdin)
    if not isinstance(payload.get("query"), str) or not payload["query"].strip():
        raise ValueError("query is required")
    return payload


def read_table(data_dir: Path, name: str, optional: bool = False):
    path = data_dir / f"{name}.parquet"
    if optional and not path.exists():
        return None
    return pd.read_parquet(path)


async def run(payload: dict) -> dict:
    root = Path(payload["root"]).resolve(strict=True)
    data = Path(payload["data"]).resolve(strict=True)
    config = load_config(root_dir=root, cli_overrides={"output_storage": {"base_dir": str(data)}})
    response, context = await api.local_search(
        config=config,
        entities=read_table(data, "entities"),
        communities=read_table(data, "communities"),
        community_reports=read_table(data, "community_reports"),
        text_units=read_table(data, "text_units"),
        relationships=read_table(data, "relationships"),
        covariates=read_table(data, "covariates", optional=True),
        community_level=2,
        response_type="Concise answer with data references",
        query=payload["query"].strip(),
        verbose=False,
    )
    sources = context.get("sources") if isinstance(context, dict) else None
    entities = context.get("entities") if isinstance(context, dict) else None
    return {
        "answer": str(response),
        "textUnitIds": selected_values(sources, "id"),
        "relatedEntities": selected_values(entities, "entity"),
    }


def selected_values(frame, column: str) -> list[str]:
    if frame is None or column not in frame.columns:
        return []
    selected = frame
    if "in_context" in selected.columns:
        selected = selected[selected["in_context"] != False]  # noqa: E712
    return list(dict.fromkeys(str(value) for value in selected[column].dropna().tolist()))


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(run(read_request())), ensure_ascii=False))
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
