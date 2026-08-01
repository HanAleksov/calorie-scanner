from datetime import datetime
from zoneinfo import ZoneInfo

APP_TZ = ZoneInfo("Europe/Sofia")


def now_local() -> datetime:
    return datetime.now(APP_TZ)


def now_local_naive() -> datetime:
    """Sofia wall-clock time with tzinfo stripped, for storing as plain ISO strings."""
    return now_local().replace(tzinfo=None)


def today_local():
    return now_local().date()
