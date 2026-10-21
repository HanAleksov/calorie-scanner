# Архив на продукцията (Coolify, Hetzner) — стъпка по стъпка

Цел: пълен, проверен и възстановим архив на **базата и на снимките** преди каквото и да е внедряване.
Този документ **не променя приложението**: не спира, не рестартира и не пише в продукционния том.

Принципи (от одобрения подход):

* Помощен контейнер получава продукционния том **само за четене** (`:ro`), инструментите **само за четене**
  и **отделна** изходна директория. Без мрежа. Контейнерът се трие сам (`--rm`).
* Инструментите са копирани на временен път извън приложението. Не е нужен push или deploy — текущият image няма `tools/`.
* SQLite snapshot-ът и копирането на снимките са отделни стъпки, затова работим в **кратък прозорец без записи**
  и го доказваме с отпечатък (SHA-256 на `.db` файла и на всяка снимка) преди и след архива.
* Проверката и възстановяването ползват **само архива** (без продукционен том), сравняват се с **фиксирания източник**
  от прозореца, а не с жива база. Копие се изнася извън сървъра и се сверява по SHA-256.
* Архивът е личен: не се качва в хранилището и не влиза в пакета за преглед.

> Командите по-долу са за твоя терминал (SSH към сървъра и PowerShell локално). От тази среда нямам достъп
> до сървъра и Docker, затова **не са изпълнявани там**. Стъпките на самите инструменти (отпечатък → архив →
> проверка → възстановяване → сравнение, плюс нарушен прозорец) са репетирани локално на измислени данни
> със същите аргументи — виж `evidence/server_procedure_rehearsal.txt` в пакета. Част 1 е само четене и е
> нужна, за да се потвърдят имената; ако нещо се различава от това, което е вписано тук, спри и ми прати изхода
> (в него няма тайни).

## Част 1 — Установяване с четене (на сървъра)

```bash
APP=mveybzy7cipxc6hosgcoifc1
docker ps --filter "name=$APP" --format '{{.ID}}   {{.Names}}   {{.Image}}   {{.Status}}'
```

Очакваш **точно един** работещ контейнер. Копирай ID-то:

```bash
CID=<ID от горния ред>
IMAGE=$(docker inspect -f '{{.Image}}' "$CID")     # ID на image-а, който работи СЕГА (не таг, който може да се премести)
echo "$IMAGE"
docker inspect -f '{{.Config.Image}}' "$CID"       # тагът, само за запис
docker inspect -f '{{range .Mounts}}{{.Type}}   name={{.Name}}   source={{.Source}}   ->   {{.Destination}}   rw={{.RW}}{{println}}{{end}}' "$CID"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CID" | grep -E '^CALORIE_(DB_PATH|UPLOADS_DIR)='
```

Последната команда печата **само** двата реда с пътищата (регулярният израз не съвпада с други променливи,
така че ключът не се показва). Очаквано: `CALORIE_DB_PATH=/data/calorie_scanner.db` и
`CALORIE_UPLOADS_DIR=/data/uploads`. **Ако не печата нищо**, приложението пише в `/app/backend/…` (не в тома) —
спри и ми прати изхода: това би било отделна находка.

От реда за монтиране с `->   /data` вземи `name=` (именуван том) или `source=` (папка на хоста):

```bash
SRC=<name или source>
DB=/data/calorie_scanner.db
UP=/data/uploads
```

Само четене на тома — какво има в него (имена и размери, без стойности), режим на журнала и свободно място:

```bash
docker run --rm --network none -v "$SRC":/data:ro --entrypoint sh "$IMAGE" -c 'ls -la /data; echo; ls /data/uploads | wc -l; du -sh /data/uploads'
docker run --rm --network none -v "$SRC":/data:ro --entrypoint python "$IMAGE" -B -c "import sqlite3; c=sqlite3.connect('file:$DB?mode=ro', uri=True); print(c.execute('PRAGMA journal_mode').fetchone(), c.execute('PRAGMA quick_check').fetchone())"
df -h /root
```

Очаквано: `('delete',) ('ok',)` и **без** файлове `*-wal`, `*-shm` или `*-journal` в `ls`. Ако журналът е `wal`
или има остатъчен `*-journal`, спри — четене от `:ro` том не е гарантирано и ще го решим поотделно.
Свободното място трябва да е поне 3× размера на `/data` (архив + разархивирано копие + отпечатъци).

## Част 2 — Копиране на инструментите (твоят PowerShell)

Инструментите са в клона `stage1-sessions` (`backend/tools/backup.py`, `backend/tools/db_snapshot.py`).

```powershell
$srv = "root@<IP-на-сървъра>"          # попълни локално; не го записвай в хранилището
ssh $srv "mkdir -p /root/cs-backup/tools /root/cs-backup/out && chmod 700 /root/cs-backup"
scp D:\calorie-scanner\backend\tools\backup.py D:\calorie-scanner\backend\tools\db_snapshot.py ${srv}:/root/cs-backup/tools/
Get-FileHash D:\calorie-scanner\backend\tools\backup.py, D:\calorie-scanner\backend\tools\db_snapshot.py -Algorithm SHA256 | Format-Table Hash, Path
```

```bash
sha256sum /root/cs-backup/tools/backup.py /root/cs-backup/tools/db_snapshot.py
```

Хешовете трябва да са еднакви (PowerShell ги печата с главни букви). Папката `/root/cs-backup/restore` **още не** трябва да съществува.

## Част 3 — Прозорец без записи: архив + фиксиран източник (на сървъра)

Предупреди Ани и не отваряй приложението за ~3 минути. Приложението **продължава да работи**; ние само не пишем в него.

```bash
BASE=/root/cs-backup
H() {   # помощен контейнер: том САМО ЗА ЧЕТЕНЕ, инструменти САМО ЗА ЧЕТЕНЕ, пише се само в /out, без мрежа
  docker run --rm --network none --read-only --tmpfs /tmp:rw,size=2g \
    -v "$SRC":/data:ro -v $BASE/tools:/tools:ro -v $BASE/out:/out \
    --entrypoint python "$IMAGE" -B "$@"
}

H /tools/backup.py fingerprint --db $DB --uploads $UP --out /out/fp_before.json
H /tools/backup.py create      --db $DB --uploads $UP --out /out
H /tools/db_snapshot.py snapshot $DB /out/source_db.json
H /tools/backup.py fingerprint --db $DB --uploads $UP --out /out/fp_after.json
H /tools/backup.py compare-fingerprint /out/fp_before.json /out/fp_after.json --same-db
```

Условия, при които прозорецът се приема:

| Стъпка | Трябва да види |
|---|---|
| `create` | завършва с `VERIFIED` (не `INCOMPLETE ARCHIVE`, не `VERIFICATION FAILED`) |
| `compare-fingerprint` | `SAME` — в прозореца никой не е пипал `.db` файла и снимките |

Ако `create` каже `INCOMPLETE ARCHIVE`, значи запис сочи към снимка, която липсва на диска: архивът е
последователен, но **не е пълен** и не изпълнява условието за внедряване — спри и ми прати списъка.
Ако `compare-fingerprint` каже `DIFFERENT`, някой е писал по време на прозореца: изтрий този архив
(`rm /root/cs-backup/out/*`) и повтори Част 3. Прозорецът свършва тук — приложението е свободно.

## Част 4 — Проверка и възстановяване от архива (без продукционния том)

```bash
ZIP=$(basename "$(ls $BASE/out/calorie-scanner-backup-*.zip)")      # точно един файл
mkdir $BASE/restore                                                  # нова, празна
R() {   # НЯМА монтиран продукционен том
  docker run --rm --network none --read-only --tmpfs /tmp:rw,size=2g \
    -v $BASE/tools:/tools:ro -v $BASE/out:/out -v $BASE/restore:/restore \
    --entrypoint python "$IMAGE" -B "$@"
}

R /tools/backup.py verify  /out/$ZIP
R /tools/backup.py restore /out/$ZIP --db /restore/calorie_scanner.db --uploads /restore/uploads
R /tools/db_snapshot.py snapshot /restore/calorie_scanner.db /out/restored_db.json
R /tools/db_snapshot.py compare /out/source_db.json /out/restored_db.json
R /tools/backup.py fingerprint --db /restore/calorie_scanner.db --uploads /restore/uploads --out /out/fp_restored.json
R /tools/backup.py compare-fingerprint /out/fp_before.json /out/fp_restored.json
```

Очаквано, по ред: `VERIFIED` → `RESTORED AND VERIFIED` → (таблици) → **`IDENTICAL`** (без никакви `--allow-*`: възстановената
база е същата като фиксирания източник, клетка по клетка) → отпечатък → **`SAME`** (всяка снимка е същата, байт по байт, спрямо
източника в прозореца).

## Част 5 — Копие извън сървъра и проверка на SHA-256

```bash
cd /root/cs-backup/out && sha256sum *.zip *.json > SHA256SUMS.txt && cat SHA256SUMS.txt
```

```powershell
$srv = "root@<IP-на-сървъра>"                           # същото като в Част 2
$dest = "D:\calorie-scanner-backups\2026-10-21"        # ИЗВЪН хранилището; личен архив
New-Item -ItemType Directory -Force $dest | Out-Null
scp "${srv}:/root/cs-backup/out/*" $dest

Get-Content "$dest\SHA256SUMS.txt" | ForEach-Object {
  $hash, $name = $_ -split '\s+', 2
  $name = $name.TrimStart('*')
  $local = (Get-FileHash (Join-Path $dest $name) -Algorithm SHA256).Hash
  "{0}  {1}" -f $(if ($local -ieq $hash) { "OK  " } else { "DIFF" }), $name
}

D:\calorie-scanner\backend\.venv\Scripts\python.exe -B D:\calorie-scanner\backend\tools\backup.py verify (Get-ChildItem $dest\calorie-scanner-backup-*.zip).FullName
```

Всеки ред трябва да е `OK`, а последната проверка — `VERIFIED` (вече върху копието на твоя диск).

## Част 6 — Какво остава на сървъра

| Път | Съдържание | Какво да правиш |
|---|---|---|
| `/root/cs-backup/out` | архивът (лични данни), отпечатъци, `SHA256SUMS.txt` | остава като второ копие до края на внедряването |
| `/root/cs-backup/restore` | разархивирано пробно копие (лични данни) | след Част 5 може да се изтрие: `rm -r /root/cs-backup/restore` |
| `/root/cs-backup/tools` | двата скрипта | безвредни |

Нищо в Coolify, в тома `/data` или в работещия контейнер не е променено; помощните контейнери са изтрити от `--rm`.

## Какво този архив доказва и какво не

* Доказва: на момента на прозореца базата и всички снимки, към които сочат записи, са в архива, архивът се чете и възстановява,
  а възстановеното е идентично с източника; копието извън сървъра е байт-за-байт същото като на сървъра.
* Не доказва: бъдещи архиви (графикът още липсва); че Coolify няма друг, непроменян от нас, източник на данни извън тома;
  нищо за поведението на новата версия зад Coolify.
* Преди внедряването за след-проверка виж „After the deploy“ в `README.md` (с изричните `--allow-new-table` / `--allow-new-column`).
