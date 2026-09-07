"""Detection tests (pure, no network)."""
from app.core.detection import detect


def test_chinese():
    r = detect("今天天气很好，我们一起出去散步吧。")
    assert r.lang == "zh"
    assert r.confidence > 0.9


def test_english():
    r = detect("The quick brown fox jumps over the lazy dog near the river.")
    assert r.lang == "en"


def test_japanese_with_kana():
    r = detect("今日は天気がいいですね、散歩しましょう。")
    assert r.lang == "ja"


def test_korean():
    r = detect("오늘 날씨가 정말 좋아요. 산책하러 갑시다.")
    assert r.lang == "ko"


def test_cyrillic():
    r = detect("Сегодня хорошая погода, пойдём гулять.")
    assert r.lang == "ru"


def test_thai():
    r = detect("วันนี้อากาศดีมาก ไปเดินเล่นกันเถอะ")
    assert r.lang == "th"


def test_french():
    r = detect("Le chat est sur le tapis et il dort tranquillement.")
    assert r.lang == "fr"


def test_german():
    r = detect("Der Hund läuft durch den großen Garten und spielt mit dem Ball.")
    assert r.lang == "de"


def test_spanish():
    r = detect("El perro corre por el parque con sus amigos todos los días.")
    assert r.lang == "es"


def test_empty_and_symbols_are_auto():
    assert detect("").lang == "auto"
    assert detect("12345 !!! @@ #$%").lang == "auto"
    assert detect("   \n\t ").lang == "auto"


def test_mixed_chinese_dominant():
    r = detect("混合 English 的中文文本，以中文为主。")
    assert r.lang == "zh"


def test_short_latin_ambiguous_stays_auto():
    # Too little evidence -> auto (upstream engines handle it).
    r = detect("Hello")
    assert r.lang in {"auto", "en"}
