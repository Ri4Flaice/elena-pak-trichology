"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import readExcelFile from "read-excel-file/browser";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FileSpreadsheet,
  LogOut,
  MailCheck,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import {
  DEFAULT_TEMPLATE,
  extractClientRows,
  prepareClients,
  validateTemplate,
  type ClientRow,
} from "@/lib/clients";

type Status =
  "PENDING" | "SENDING" | "ACCEPTED" | "ERROR" | "UNKNOWN" | "SKIPPED";
type Recipient = {
  id: string;
  rowNumber: number;
  firstName: string;
  lastName: string;
  phone: string;
  message: string;
  status: Status;
  error: string | null;
  idMessage: string | null;
};
type Campaign = {
  id: string;
  fileName: string;
  status: string;
  createdAt: string;
  recipients: Recipient[];
};
type Summary = {
  id: string;
  fileName: string;
  status: string;
  createdAt: string;
  counts: Record<string, number>;
};
const PAGE_SIZE = 10;
const TEMPLATE_STORAGE_KEY = "elena-pak-mailer-template";
const TEMPLATE_CHANGED_EVENT = "elena-pak-template-changed";
let inMemoryTemplate: string | null = null;

function getSavedTemplate() {
  try {
    return (
      localStorage.getItem(TEMPLATE_STORAGE_KEY) ??
      inMemoryTemplate ??
      DEFAULT_TEMPLATE
    );
  } catch {
    return inMemoryTemplate ?? DEFAULT_TEMPLATE;
  }
}

function subscribeToTemplate(callback: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === TEMPLATE_STORAGE_KEY || event.key === null) {
      inMemoryTemplate = event.newValue;
      callback();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(TEMPLATE_CHANGED_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(TEMPLATE_CHANGED_EVENT, callback);
  };
}

function saveTemplate(value: string) {
  inMemoryTemplate = value;
  try {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, value);
  } catch {
    // Редактирование остаётся доступным, если хранилище браузера заблокировано.
  }
  window.dispatchEvent(new Event(TEMPLATE_CHANGED_EVENT));
}

const STATUS_LABEL: Record<Status, string> = {
  PENDING: "Ожидает",
  SENDING: "Отправляется",
  ACCEPTED: "Принято GreenAPI",
  ERROR: "Ошибка",
  UNKNOWN: "Результат неизвестен",
  SKIPPED: "Пропущено",
};

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error ?? `Ошибка HTTP ${response.status}`);
  return data as T;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function Dashboard() {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ClientRow[]>([]);
  const template = useSyncExternalStore(
    subscribeToTemplate,
    getSavedTemplate,
    () => DEFAULT_TEMPLATE,
  );
  const [selected, setSelected] = useState<number[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewSearch, setPreviewSearch] = useState("");
  const [previewPage, setPreviewPage] = useState(1);
  const [history, setHistory] = useState<Summary[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [openingCampaignId, setOpeningCampaignId] = useState<string | null>(
    null,
  );
  const [historyError, setHistoryError] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [reportPage, setReportPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const reportRef = useRef<HTMLElement>(null);
  const scrollToCampaignIdRef = useRef<string | null>(null);
  const stopRef = useRef(false);
  const sendingRef = useRef(false);

  const templateError = validateTemplate(template);
  const prepared = useMemo(() => {
    if (!rows.length || templateError) return null;
    try {
      return prepareClients(rows, template);
    } catch {
      return null;
    }
  }, [rows, template, templateError]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredPreview = useMemo(
    () =>
      (prepared?.valid ?? []).filter((row) =>
        `${row.firstName} ${row.lastName} ${row.phone} ${row.message}`
          .toLowerCase()
          .includes(previewSearch.toLowerCase().trim()),
      ),
    [prepared, previewSearch],
  );
  const filteredReport = useMemo(
    () =>
      (campaign?.recipients ?? []).filter((row) =>
        `${row.firstName} ${row.lastName} ${row.phone} ${row.message} ${row.error ?? ""} ${STATUS_LABEL[row.status]}`
          .toLowerCase()
          .includes(reportSearch.toLowerCase().trim()),
      ),
    [campaign, reportSearch],
  );
  const counts = useMemo(
    () =>
      (campaign?.recipients ?? []).reduce(
        (result, row) => {
          result[row.status] = (result[row.status] ?? 0) + 1;
          return result;
        },
        {} as Record<string, number>,
      ),
    [campaign],
  );

  const loadHistory = useCallback(async () => {
    try {
      setHistory(
        (await api<{ campaigns: Summary[] }>("/api/campaigns")).campaigns,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось загрузить историю",
      );
    }
  }, []);

  const loadCampaign = useCallback(async (id: string) => {
    const result = await api<{ campaign: Campaign }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
    );
    setCampaign(result.campaign);
    return result.campaign;
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ campaigns: Summary[] }>("/api/campaigns")
      .then((result) => {
        if (!cancelled) setHistory(result.campaigns);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(
            caught instanceof Error
              ? caught.message
              : "Не удалось загрузить историю",
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!campaign || scrollToCampaignIdRef.current !== campaign.id) return;
    scrollToCampaignIdRef.current = null;
    reportRef.current?.focus({ preventScroll: true });
    reportRef.current?.scrollIntoView({ block: "start" });
  }, [campaign]);

  async function openCampaignFromHistory(id: string) {
    setOpeningCampaignId(id);
    setHistoryError("");
    scrollToCampaignIdRef.current = id;
    try {
      await loadCampaign(id);
      setReportSearch("");
      setReportPage(1);
    } catch (caught) {
      scrollToCampaignIdRef.current = null;
      setHistoryError(
        caught instanceof Error
          ? caught.message
          : "Не удалось открыть рассылку",
      );
    } finally {
      setOpeningCampaignId(null);
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setNotice("");
    setPreviewReady(false);
    setRows([]);
    setSelected([]);
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Выберите файл Excel в формате .xlsx");
      return;
    }
    setBusy(true);
    try {
      const sheets = await readExcelFile(file);
      const sheet = sheets.find((item) => item.sheet.trim() === "Клиенты");
      if (!sheet) throw new Error("В файле не найден лист «Клиенты».");
      const parsedRows = extractClientRows(sheet.data);
      if (!parsedRows.length)
        throw new Error("На листе «Клиенты» нет записей.");
      setFileName(file.name);
      setRows(parsedRows);
      if (!validateTemplate(template))
        setSelected(
          prepareClients(parsedRows, template).valid.map(
            (row) => row.rowNumber,
          ),
        );
      setNotice(`Файл загружен: ${parsedRows.length} заполненных строк.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось прочитать Excel-файл",
      );
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  function insertToken(token: string) {
    const input = templateRef.current;
    const start = input?.selectionStart ?? template.length;
    const end = input?.selectionEnd ?? template.length;
    saveTemplate(`${template.slice(0, start)}${token}${template.slice(end)}`);
    setPreviewReady(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function sendLoop(id: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    stopRef.current = false;
    setSending(true);
    setError("");
    try {
      for (;;) {
        if (stopRef.current) break;
        const result = await api<{
          done: boolean;
          processed: number;
          sending: number;
        }>(`/api/campaigns/${encodeURIComponent(id)}/send-batch`, {
          method: "POST",
        });
        await loadCampaign(id);
        await loadHistory();
        if (result.done) {
          setNotice("Обработка рассылки завершена.");
          break;
        }
        if (!result.processed) {
          setNotice(
            "Текущий пакет ещё обрабатывается. Повторите продолжение позже.",
          );
          break;
        }
      }
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : "Ошибка отправки"}. Проверьте журнал перед продолжением.`,
      );
      await loadCampaign(id).catch(() => undefined);
      await loadHistory();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function start() {
    if (!prepared || !selected.length || templateError) return;
    if (
      !window.confirm(
        `Начать отправку ${selected.length} клиентам? Проверьте текст и список получателей.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ id: string }>("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName,
          template,
          rows,
          selectedRowNumbers: selected,
        }),
      });
      await loadCampaign(result.id);
      await loadHistory();
      setBusy(false);
      void sendLoop(result.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось создать рассылку",
      );
      setBusy(false);
    }
  }

  async function retryErrors() {
    if (
      !campaign ||
      !window.confirm("Повторить только сообщения с подтверждённой ошибкой?")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/campaigns/${campaign.id}/retry`, { method: "POST" });
      await loadCampaign(campaign.id);
      await loadHistory();
      setBusy(false);
      void sendLoop(campaign.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось повторить отправку",
      );
      setBusy(false);
    }
  }

  async function deleteCampaign() {
    if (
      !campaign ||
      !window.confirm(
        "Удалить эту рассылку и весь её журнал без возможности восстановления?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      setCampaign(null);
      await loadHistory();
      setNotice("История рассылки удалена.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось удалить рассылку",
      );
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    if (!campaign) return;
    const head = [
      "Строка",
      "Фамилия",
      "Имя",
      "Телефон",
      "Сообщение",
      "Статус",
      "Ошибка",
      "ID GreenAPI",
    ];
    const body = campaign.recipients.map((row) => [
      row.rowNumber,
      row.lastName,
      row.firstName,
      row.phone,
      row.message,
      STATUS_LABEL[row.status],
      row.error ?? "",
      row.idMessage ?? "",
    ]);
    const csv =
      "\ufeff" +
      [head, ...body].map((row) => row.map(csvCell).join(";")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `рассылка-${campaign.id}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    window.location.reload();
  }

  const previewRows = filteredPreview.slice(
    (previewPage - 1) * PAGE_SIZE,
    previewPage * PAGE_SIZE,
  );
  const reportRows = filteredReport.slice(
    (reportPage - 1) * PAGE_SIZE,
    reportPage * PAGE_SIZE,
  );

  return (
    <main>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div>
              <strong>Елена Пак</strong>
              <small>Кабинет рассылок</small>
            </div>
          </div>
          <button className="ghost-button" onClick={logout}>
            <LogOut size={17} /> Выйти
          </button>
        </div>
      </header>
      <div className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">WHATSAPP · РАССЫЛКИ</p>
            <h1>Сообщения клиентам</h1>
            <p className="muted">
              Загрузите базу, проверьте сообщения и запустите отправку.
            </p>
          </div>
          <span className="private-badge">
            <Check size={14} /> Служебный доступ
          </span>
        </div>
        {error && (
          <div className="alert error" role="alert">
            <CircleAlert size={18} />
            {error}
            <button onClick={() => setError("")} aria-label="Закрыть">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            <Check size={18} />
            {notice}
            <button onClick={() => setNotice("")} aria-label="Закрыть">
              ×
            </button>
          </div>
        )}

        <section className="panel" aria-labelledby="upload-heading">
          <div className="section-heading">
            <span className="step">01</span>
            <div>
              <h2 id="upload-heading">Загрузите клиентов</h2>
              <p>
                Файл Excel читается в браузере. На сервер попадут только данные
                для рассылки.
              </p>
            </div>
          </div>
          <label className="upload-area">
            <Upload size={23} />
            <span>
              <strong>{fileName || "Выберите файл .xlsx"}</strong>
              <small>
                Нужен лист «Клиенты» со столбцами «Фамилия», «Имя», «Телефон»
              </small>
            </span>
            <input
              type="file"
              accept=".xlsx"
              onChange={upload}
              disabled={busy || sending}
            />
          </label>
        </section>

        <section className="panel" aria-labelledby="template-heading">
          <div className="section-heading">
            <span className="step">02</span>
            <div>
              <h2 id="template-heading">Подготовьте сообщение</h2>
              <p>
                Переменные заменятся данными каждого клиента. Шаблон сохраняется
                в этом браузере автоматически.
              </p>
            </div>
          </div>
          <div className="template-toolbar">
            <span>Вставить переменную:</span>
            <button onClick={() => insertToken("{{Имя}}")}>+ Имя</button>
            <button onClick={() => insertToken("{{Фамилия}}")}>
              + Фамилия
            </button>
          </div>
          <textarea
            ref={templateRef}
            value={template}
            onChange={(event) => {
              saveTemplate(event.target.value);
              setPreviewReady(false);
            }}
            rows={7}
            aria-label="Шаблон сообщения"
            placeholder="Введите текст сообщения"
          />
          <div className="form-foot">
            <span className={templateError ? "error-text" : "muted"}>
              {templateError ?? `${template.length} / 20 000 символов`}
            </span>
            <button
              className="secondary-button"
              disabled={!rows.length || !!templateError || busy}
              onClick={() => {
                setPreviewReady(true);
                setPreviewPage(1);
              }}
            >
              <MailCheck size={17} /> Предпросмотр
            </button>
          </div>
        </section>

        {previewReady && prepared && (
          <section className="panel" aria-labelledby="preview-heading">
            <div className="section-heading">
              <span className="step">03</span>
              <div>
                <h2 id="preview-heading">Проверьте получателей</h2>
                <p>
                  Поиск не меняет состав рассылки. Снимите отметку у тех, кому
                  писать не нужно.
                </p>
              </div>
            </div>
            <div className="metrics">
              <div>
                <strong>{prepared.valid.length}</strong>
                <span>Корректных</span>
              </div>
              <div>
                <strong>{selected.length}</strong>
                <span>Выбрано</span>
              </div>
              <div>
                <strong>{prepared.skipped.length}</strong>
                <span>Пропущено</span>
              </div>
            </div>
            <div className="table-tools">
              <label className="search">
                <Search size={17} />
                <input
                  value={previewSearch}
                  onChange={(e) => {
                    setPreviewSearch(e.target.value);
                    setPreviewPage(1);
                  }}
                  placeholder="Поиск по имени, телефону, сообщению"
                />
              </label>
              <div className="tool-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    setSelected(prepared.valid.map((row) => row.rowNumber))
                  }
                >
                  Выбрать всех
                </button>
                <button className="text-button" onClick={() => setSelected([])}>
                  Снять все
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Выбор</th>
                    <th>Клиент</th>
                    <th>WhatsApp</th>
                    <th>Сообщение</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${row.firstName} ${row.lastName}`}
                          checked={selectedSet.has(row.rowNumber)}
                          onChange={() =>
                            setSelected((current) =>
                              current.includes(row.rowNumber)
                                ? current.filter((n) => n !== row.rowNumber)
                                : [...current, row.rowNumber],
                            )
                          }
                        />
                      </td>
                      <td data-label="Клиент">
                        <strong>
                          {row.lastName} {row.firstName}
                        </strong>
                        <small>Строка {row.rowNumber}</small>
                      </td>
                      <td data-label="WhatsApp">+{row.phone}</td>
                      <td data-label="Сообщение">
                        <span className="message-preview">{row.message}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!previewRows.length && (
                <p className="empty">Совпадений не найдено.</p>
              )}
            </div>
            <Pagination
              page={previewPage}
              total={filteredPreview.length}
              onPage={setPreviewPage}
            />
            {prepared.skipped.length > 0 && (
              <details className="skipped">
                <summary>Пропущенные строки: {prepared.skipped.length}</summary>
                <div className="skipped-list">
                  {prepared.skipped.map((row) => (
                    <p key={row.rowNumber}>
                      Строка {row.rowNumber}: {row.lastName} {row.firstName} ·{" "}
                      {row.rawPhone || "без телефона"} — {row.reason}
                    </p>
                  ))}
                </div>
              </details>
            )}
            <div className="send-bar">
              <div>
                <strong>К отправке: {selected.length}</strong>
                <span>По одному сообщению на уникальный номер</span>
              </div>
              <button
                className="primary-button"
                disabled={!selected.length || busy || sending}
                onClick={start}
              >
                <Play size={17} /> Начать рассылку
              </button>
            </div>
          </section>
        )}

        {campaign && (
          <section
            ref={reportRef}
            tabIndex={-1}
            className="panel"
            aria-labelledby="report-heading"
          >
            <div className="section-heading">
              <span className="step dark">04</span>
              <div>
                <h2 id="report-heading">Журнал рассылки</h2>
                <p>
                  {campaign.fileName} ·{" "}
                  {new Date(campaign.createdAt).toLocaleString("ru-RU")}
                </p>
              </div>
            </div>
            <div className="metrics report-metrics">
              <div>
                <strong>{counts.ACCEPTED ?? 0}</strong>
                <span>Принято GreenAPI</span>
              </div>
              <div>
                <strong>{counts.PENDING ?? 0}</strong>
                <span>Ожидает</span>
              </div>
              <div>
                <strong>{counts.SENDING ?? 0}</strong>
                <span>В обработке</span>
              </div>
              <div>
                <strong>{counts.ERROR ?? 0}</strong>
                <span>Ошибок</span>
              </div>
              <div>
                <strong>{counts.UNKNOWN ?? 0}</strong>
                <span>Неизвестно</span>
              </div>
            </div>
            <div className="report-actions">
              {((counts.PENDING ?? 0) > 0 || (counts.SENDING ?? 0) > 0) && (
                <button
                  className="primary-button"
                  disabled={sending || busy}
                  onClick={() => void sendLoop(campaign.id)}
                >
                  <Play size={16} /> Продолжить
                </button>
              )}
              {sending && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    stopRef.current = true;
                    setNotice("Остановим после текущего пакета.");
                  }}
                >
                  <Square size={16} /> Остановить после пакета
                </button>
              )}
              {(counts.ERROR ?? 0) > 0 && (
                <button
                  className="secondary-button"
                  disabled={sending || busy}
                  onClick={retryErrors}
                >
                  <RefreshCw size={16} /> Повторить ошибки
                </button>
              )}
              <button className="secondary-button" onClick={downloadCsv}>
                <Download size={16} /> Скачать CSV
              </button>
              <button
                className="danger-button"
                disabled={sending || busy}
                onClick={deleteCampaign}
              >
                <Trash2 size={16} /> Удалить
              </button>
            </div>
            {sending && (
              <p className="live-status">
                <span className="spinner" />
                Отправка идёт. Не закрывайте вкладку.
              </p>
            )}
            <div className="table-tools">
              <label className="search">
                <Search size={17} />
                <input
                  value={reportSearch}
                  onChange={(e) => {
                    setReportSearch(e.target.value);
                    setReportPage(1);
                  }}
                  placeholder="Поиск в журнале"
                />
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>WhatsApp</th>
                    <th>Статус</th>
                    <th>Результат</th>
                  </tr>
                </thead>
                <tbody>
                  {reportRows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Клиент">
                        <strong>
                          {row.lastName} {row.firstName}
                        </strong>
                        <small>Строка {row.rowNumber}</small>
                      </td>
                      <td data-label="WhatsApp">
                        {row.phone.startsWith("7") ? "+" : ""}
                        {row.phone}
                      </td>
                      <td data-label="Статус">
                        <span
                          className={`status status-${row.status.toLowerCase()}`}
                        >
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td data-label="Результат">
                        <span className="result-text">
                          {row.error ?? row.idMessage ?? "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!reportRows.length && (
                <p className="empty">Совпадений не найдено.</p>
              )}
            </div>
            <Pagination
              page={reportPage}
              total={filteredReport.length}
              onPage={setReportPage}
            />
          </section>
        )}

        <section
          className="panel history-panel"
          aria-labelledby="history-heading"
        >
          <div className="section-heading">
            <FileSpreadsheet size={22} className="history-icon" />
            <div>
              <h2 id="history-heading">История рассылок</h2>
              <p>
                Последние 30 запусков. Результаты сохраняются после закрытия
                страницы.
              </p>
            </div>
          </div>
          {historyError && (
            <p className="error-text" role="alert">
              {historyError}
            </p>
          )}
          {!history.length ? (
            <p className="empty">Рассылок пока нет.</p>
          ) : (
            <div className="history-list">
              {history.map((item) => (
                <button
                  key={item.id}
                  className={`history-item ${campaign?.id === item.id ? "active" : ""}`}
                  disabled={openingCampaignId !== null}
                  aria-pressed={campaign?.id === item.id}
                  onClick={() => void openCampaignFromHistory(item.id)}
                >
                  <span>
                    <strong>{item.fileName}</strong>
                    <small>
                      {new Date(item.createdAt).toLocaleString("ru-RU")}
                    </small>
                  </span>
                  <span className="history-counts">
                    {openingCampaignId === item.id ? (
                      "Открываем журнал…"
                    ) : (
                      <>
                        {item.counts.ACCEPTED ?? 0} принято ·{" "}
                        {item.counts.ERROR ?? 0} ошибок ·{" "}
                        {item.counts.PENDING ?? 0} ждут
                      </>
                    )}
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
          )}
        </section>
        <footer>Елена Пак · Служебный кабинет</footer>
      </div>
    </main>
  );
}

function Pagination({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return <p className="pagination-total">Всего: {total}</p>;
  return (
    <div className="pagination">
      <span>
        Страница {page} из {pages} · всего {total}
      </span>
      <div>
        <button
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Предыдущая страница"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Следующая страница"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
