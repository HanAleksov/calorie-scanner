# Архив на продукцията (Coolify, Hetzner) — стъпка по стъпка

Цел: пълен, проверен и възстановим архив на **базата и на снимките** преди внедряването на Етап 1.

Принципи:

* **Техническият прозорец без записи е реален, не само обявен.** Приложението (контейнерът) се спира
  грациозно (`docker stop`) само за няколко секунди — колкото траят отпечатъкът, архивът, снимката на
  източника и вторият отпечатък — и се пуска отново от `trap`, който се изпълнява при **всеки** изход
  (успех, грешка, Ctrl-C, затворен терминал). Еднакви отпечатъци преди и след сами не доказват, че
  междувременно няма записи (запис и обратна промяна, или два записа, не се виждат); спряното приложение го
  прави невъзможно, а отпечатъците остават като втора проверка, че нищо друго не е пипало данните.
* Помощният контейнер получава продукционния том **само за четене** (`:ro`), инструментите **само за четене**,
  **отделна** изходна директория и няма мрежа. Проверката и възстановяването стават само от архива.
* **Всеки опит има своя директория** `$BASE/attempts/<час>/`. Нищо не се трие и не се използва повторно;
  неуспешният опит остава (архив, логове, файл `FAILED`) за диагностика.
* Не е нужен push или deploy: инструментите се копират като файлове.
* Архивът е личен: не влиза в хранилището и не влиза в пакета за преглед.

> От тази среда нямам достъп до сървъра и Docker. Логиката на `archive_window.sh` е репетирана тук срещу
> заместител на `docker` с измислени данни: щастлив път, запис в прозореца, провал на snapshot, провал на
> `docker stop`, провал на `docker start` и Ctrl-C по средата — във всеки случай приложението е върнато (или
> скриптът казва на глас, че не е) и папката на опита е запазена (`evidence/window_rehearsal/`). Истинският
> `docker run … :ro`, `docker stop/start` и Coolify не са изпитвани оттук, затова се върви на стъпки и всяка
> зависи от изхода на предишната.

## Стъпка 1 — Установяване с четене (на сървъра; нищо не променя)

```bash
APP=mveybzy7cipxc6hosgcoifc1
docker ps --filter "name=$APP" --format '{{.ID}}   {{.Names}}   {{.Image}}   {{.Status}}'
```

Очаквано: **точно един** работещ контейнер. После, с ID-то от първата колона:

```bash
CID=<ID от горния ред>
IMAGE=$(docker inspect -f '{{.Image}}' "$CID"); echo "$IMAGE"
docker inspect -f 'tag: {{.Config.Image}}{{println}}created: {{.Created}}{{println}}started: {{.State.StartedAt}}{{println}}restart: {{.HostConfig.RestartPolicy.Name}}{{println}}status: {{.State.Status}}{{if .State.Health}} health={{.State.Health.Status}}{{end}}' "$CID"
docker inspect -f '{{range .Mounts}}{{.Type}}   name={{.Name}}   source={{.Source}}   ->   {{.Destination}}   rw={{.RW}}{{println}}{{end}}' "$CID"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CID" | grep -E '^CALORIE_(DB_PATH|UPLOADS_DIR)='
docker exec "$CID" curl -fsS http://localhost:8000/health; echo
df -h /root
```

Предпоследната команда печата **само** двата реда с пътищата (регулярният израз не пуска други променливи).
`/health` връща кратък отговор без данни. Ако нещо се различава от очакваното (повече от един контейнер,
няма ред `CALORIE_…`, монтираният том не е на `/data`) — спри и ми прати изхода; в него няма тайни.

## Стъпка 2 — Какво има в тома (само четене)

От реда за монтиране с `->   /data` вземи `name=` (именуван том) или `source=` (папка на хоста):

```bash
SRC=<name или source>
DB=/data/calorie_scanner.db
UP=/data/uploads
docker run --rm --network none -v "$SRC":/data:ro --entrypoint sh "$IMAGE" -c 'ls -la /data; echo; ls /data/uploads | wc -l; du -sh /data/uploads'
docker run --rm --network none -v "$SRC":/data:ro --entrypoint python "$IMAGE" -B -c "import sqlite3; c=sqlite3.connect('file:$DB?mode=ro', uri=True); print(c.execute('PRAGMA journal_mode').fetchone(), c.execute('PRAGMA quick_check').fetchone()); print([(r[0], r[1]) for r in c.execute('PRAGMA table_info(entries)') if r[1].startswith('image_path')])"
docker run --rm --network none -v "$SRC":/data:ro --entrypoint python "$IMAGE" -B -c "import sqlite3; c=sqlite3.connect('file:$DB?mode=ro', uri=True); [print(r) for r in c.execute(\"SELECT id, CASE WHEN pin_hash IS NULL THEN 'no-pin' WHEN pin_hash LIKE 'pbkdf2%' THEN 'pbkdf2' ELSE 'legacy-sha256' END FROM users\")]"
```

Очаквано: `('delete',) ('ok',)`, и двете колони `image_path` и `image_path2`, без файлове `*-wal`, `*-shm`,
`*-journal`. Последният ред показва само **дали** профилът има PIN и в какъв формат (не самия хеш) —
трябва ни за плана за връщане назад. Свободното място трябва да е поне 3× размера на `/data`.

## Стъпка 3 — Инструментите на сървъра (твоят PowerShell)

```powershell
$srv = "root@<IP-на-сървъра>"          # попълни локално; не го записвай в хранилището
ssh $srv "mkdir -p /root/cs-backup/tools && chmod 700 /root/cs-backup"
scp D:\calorie-scanner\backend\tools\backup.py D:\calorie-scanner\backend\tools\db_snapshot.py ${srv}:/root/cs-backup/tools/
scp D:\calorie-scanner\backend\tools\archive_window.sh ${srv}:/root/cs-backup/
Get-FileHash D:\calorie-scanner\backend\tools\backup.py, D:\calorie-scanner\backend\tools\db_snapshot.py, D:\calorie-scanner\backend\tools\archive_window.sh -Algorithm SHA256 | Format-Table Hash, Path
```

```bash
sha256sum /root/cs-backup/tools/backup.py /root/cs-backup/tools/db_snapshot.py /root/cs-backup/archive_window.sh
```

Хешовете трябва да са еднакви (PowerShell ги печата с главни букви).
Ако скриптът е копиран от Windows, пусни `sed -i 's/\r$//' /root/cs-backup/archive_window.sh` (CRLF).

## Стъпка 4 — Архивът в технически прозорец

Предупреди Ани, че приложението ще е недостъпно ~1 минута. Скриптът прави всичко и **винаги** връща приложението:

```bash
export CID=… IMAGE=… SRC=… DB=/data/calorie_scanner.db UP=/data/uploads BASE=/root/cs-backup
bash /root/cs-backup/archive_window.sh
```

Какво прави, по ред: записва контекста (`context.txt`) → проверява журнала `delete` → **спира приложението** →
проверява, че няма недовършен журнал → отпечатък → архив (създаването го проверява) → снимка на източника →
отпечатък → сравнява ги → **пуска приложението и чака `/health`** → от тук нататък работи само върху архива:
проверка, възстановяване в нови празни пътища, сравнение с **фиксирания източник** без позволения (`IDENTICAL`),
отпечатък на възстановените снимки (`SAME`) и `SHA256SUMS.txt`.

| Край на скрипта | Значение |
|---|---|
| `ACCEPTED <папка>` и файл `ACCEPTED`, код 0 | всички условия са изпълнени |
| `NOT ACCEPTED`, файл `FAILED`, код 1 | опитът е отхвърлен; архивът и логовете **остават**; приложението е върнато |
| код 3 и `!! THE APP DID NOT COME BACK` | приложението не се вдига — ръчно: `docker start $CID; docker logs --tail 50 $CID`, или Restart от Coolify |
| код 130 | прекъснат (Ctrl-C); приложението е върнато, опитът е запазен |

Повторен опит = просто пускаш скрипта пак (нова папка). Приложението е спряно само между редовете
„STOPPING THE APP“ и „WINDOW CLOSES“.

## Стъпка 5 — Копие извън сървъра и проверка на SHA-256

```powershell
$srv = "root@<IP-на-сървъра>"
$att = ssh $srv "ls -d /root/cs-backup/attempts/* | tail -1"        # провери, че е ACCEPTED опитът
$dest = "D:\calorie-scanner-backups\2026-10-21"                    # ИЗВЪН хранилището; личен архив
New-Item -ItemType Directory -Force $dest | Out-Null
scp "${srv}:${att}/out/*" $dest

Get-Content "$dest\SHA256SUMS.txt" | ForEach-Object {
  $hash, $name = $_ -split '\s+', 2
  $name = $name.TrimStart('*')
  $local = (Get-FileHash (Join-Path $dest $name) -Algorithm SHA256).Hash
  "{0}  {1}" -f $(if ($local -ieq $hash) { "OK  " } else { "DIFF" }), $name
}

D:\calorie-scanner\backend\.venv\Scripts\python.exe -B D:\calorie-scanner\backend\tools\backup.py verify (Get-ChildItem $dest\calorie-scanner-backup-*.zip).FullName
```

Всеки ред трябва да е `OK`, а последната проверка — `VERIFIED` (вече върху копието на твоя диск).

## Какво остава на сървъра

| Път | Съдържание | Какво да правиш |
|---|---|---|
| `/root/cs-backup/attempts/<час>/out` | архивът (лични данни), отпечатъци, `SHA256SUMS.txt` | остава като второ копие до края на внедряването |
| `/root/cs-backup/attempts/<час>/restore` | разархивирано пробно копие (лични данни) | може да се изтрие ръчно след Стъпка 5; **само** на приет опит |
| неуспешни опити | архив + `log.txt` + `FAILED` | остават за диагностика |

## Какво този архив доказва и какво не

* Доказва: при спряно приложение базата и всички снимки, към които сочат записи, са в архива; архивът се чете и
  възстановява; възстановеното е идентично с източника; копието извън сървъра е байт-за-байт същото.
* Не доказва: бъдещи архиви (графикът още липсва); че Coolify няма друг източник на данни извън тома;
  нищо за поведението на новата версия зад Coolify.
* Преди внедряването за след-проверка виж „After the deploy“ в `README.md` (с изричните `--allow-new-table` / `--allow-new-column`).
