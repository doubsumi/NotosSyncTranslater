"""Segmentation tests (blocks, diff windows, sub-chunking)."""
from app.core.segmentation import (
    assemble,
    changed_range,
    map_blocks,
    rebuild_with_translations,
    split_blocks,
    subchunk,
)


def test_split_assemble_roundtrip():
    text = "first line\nsecond\n\n\nfourth with trailing\n"
    assert assemble(split_blocks(text)) == "first line\nsecond\nfourth with trailing"


def test_map_rebuild_preserves_layout():
    text = "alpha\n\n\nbeta\n\ngamma"
    blocks = map_blocks(text)
    assert len(blocks) == 3
    translations = {0: "A", 2: "C"}
    out = rebuild_with_translations(text, translations)
    assert out == "A\n\n\nbeta\n\nC"


def test_changed_range_none_when_equal():
    assert changed_range(["a", "b", "c"], ["a", "b", "c"]) is None


def test_changed_range_middle_edit():
    prev = ["a", "b", "c", "d"]
    curr = ["a", "b", "XX", "d"]
    assert changed_range(prev, curr) == (2, 3)


def test_changed_range_insert_middle_shifts_nothing_reusable_below():
    prev = ["a", "b", "c"]
    curr = ["a", "b", "NEW", "c"]
    # "c" matches the tail so only the insertion is changed.
    assert changed_range(prev, curr) == (2, 3)


def test_changed_range_full_replace():
    prev = ["a", "b"]
    curr = ["x", "y", "z"]
    assert changed_range(prev, curr) == (0, 3)


def test_changed_range_delete_last():
    prev = ["a", "b", "c"]
    curr = ["a", "b"]
    assert changed_range(prev, curr) == (2, 2)


def test_subchunk_identity_for_long_text():
    text = ("Sentence one here. " * 40) + "结尾句。中文也很重要。" * 30 + "🌟 emoji test " * 10
    chunks = subchunk(text, 200)
    assert "".join(chunks) == text
    assert all(len(c) <= 200 for c in chunks)


def test_subchunk_short_text_single():
    assert subchunk("short", 1600) == ["short"]


def test_subchunk_hard_cut_without_punctuation():
    text = "x" * 5000
    chunks = subchunk(text, 500)
    assert "".join(chunks) == text
    assert all(len(c) <= 500 for c in chunks)
