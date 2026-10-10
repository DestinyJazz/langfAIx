"""Name-and-password sign-in, the parts without a database: password hashing, session tokens, throttling."""

from app.accounts import (
    SESSION_PREFIX,
    LoginThrottle,
    check_password,
    clean_login,
    hash_password,
    hash_token,
    login_key,
    login_problems,
    new_session_token,
    password_problems,
    verify_password,
)

# ---------- Password hashing ----------


def test_the_right_password_matches_and_a_wrong_one_does_not():
    stored = hash_password("correct horse")
    assert verify_password("correct horse", stored)
    assert not verify_password("correct horsf", stored)
    assert not verify_password("", stored)


def test_what_is_stored_is_not_the_password():
    stored = hash_password("correct horse")
    assert stored.startswith("scrypt$14$8$1$")
    assert "correct horse" not in stored


def test_the_same_password_twice_is_stored_differently():
    # A new salt every time, so two people with the same password look different in the database.
    assert hash_password("correct horse") != hash_password("correct horse")


def test_chinese_passwords_work():
    stored = hash_password("我的密码很长很长")
    assert verify_password("我的密码很长很长", stored)
    assert not verify_password("我的密码很长很短", stored)


def test_anything_unreadable_in_the_database_counts_as_wrong():
    for stored in ["", "plain text", "scrypt$14$8$1$only-five", "md5$14$8$1$AAAA$AAAA", "scrypt$99$8$1$AAAA$AAAA", "scrypt$x$8$1$AAAA$AAAA", "scrypt$14$8$1$!!$!!"]:
        assert not verify_password("correct horse", stored), stored


def test_an_overlong_password_is_refused_without_hashing():
    assert not verify_password("x" * 201, hash_password("x" * 200))


def test_an_unknown_name_is_always_wrong():
    assert check_password("anything", None) is False
    assert check_password("correct horse", hash_password("correct horse")) is True


# ---------- Rules for names and passwords ----------


def test_names_compare_without_case_width_or_extra_spaces():
    assert login_key("  Amy   Wong ") == login_key("amy wong") == login_key("ＡＭＹ ＷＯＮＧ")
    assert clean_login("  Amy   Wong ") == "Amy Wong"
    assert login_key("阿美") == "阿美"


def test_name_rules():
    assert login_problems("amy") == []
    assert login_problems("阿美丽") == []
    assert "at least 3" in login_problems("ab")[0]
    assert "too long" in login_problems("a" * 61)[0]
    # A key or a session token pasted into the name field.
    assert "looks like an API key" in login_problems("sk-abcdef123456")[0]
    assert "looks like an API key" in login_problems("lfs_abcdef123456")[0]


def test_password_rules():
    assert password_problems("correct horse", "amy") == []
    assert "at least 8" in password_problems("short", "amy")[0]
    assert "too long" in password_problems("x" * 201, "amy")[0]
    assert "same as the sign-in name" in password_problems("Amy Wong 1", "amy wong 1")[0]
    assert "API key" in password_problems("sk-amy-12345", "amy", key="sk-amy-12345")[0]


# ---------- Session tokens ----------


def test_tokens_are_long_random_and_recognisable():
    one, two = new_session_token(), new_session_token()
    assert one != two
    assert one.startswith(SESSION_PREFIX) and len(one) > 40
    assert not one.startswith("sk-")  # cannot be mistaken for a virtual key
    assert hash_token(one) != one and len(hash_token(one)) == 64
    assert hash_token(one) == hash_token(one)


# ---------- Too many wrong passwords ----------


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_five_wrong_passwords_lock_the_name_for_a_while():
    clock = Clock()
    throttle = LoginThrottle(clock)
    for _ in range(4):
        throttle.failed("amy")
    assert throttle.wait_seconds("amy") == 0
    throttle.failed("amy")
    assert throttle.wait_seconds("amy") > 0
    assert throttle.wait_seconds("ben") == 0  # others are not affected

    clock.now += LoginThrottle.WINDOW_SECONDS + 1
    assert throttle.wait_seconds("amy") == 0


def test_a_correct_password_clears_the_count():
    throttle = LoginThrottle(Clock())
    for _ in range(4):
        throttle.failed("amy")
    throttle.succeeded("amy")
    for _ in range(4):
        throttle.failed("amy")
    assert throttle.wait_seconds("amy") == 0


def test_old_failures_do_not_add_up_forever():
    clock = Clock()
    throttle = LoginThrottle(clock)
    for _ in range(4):
        throttle.failed("amy")
    clock.now += LoginThrottle.WINDOW_SECONDS + 1
    throttle.failed("amy")  # a failure much later starts counting from zero
    assert throttle.wait_seconds("amy") == 0


def test_the_table_of_failures_cannot_grow_without_limit():
    throttle = LoginThrottle(Clock())
    for number in range(LoginThrottle.MAX_TRACKED + 50):
        throttle.failed(f"made-up-{number}")
    assert len(throttle._failures) <= LoginThrottle.MAX_TRACKED
