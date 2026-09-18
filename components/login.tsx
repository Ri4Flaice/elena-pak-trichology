"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";

export function Login() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Не удалось войти");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось войти");
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">Елена Пак</div>
        <p className="eyebrow">СЛУЖЕБНЫЙ КАБИНЕТ</p>
        <h1>Рассылки клиентам</h1>
        <p className="muted">
          Войдите, чтобы подготовить сообщения и отправить их в WhatsApp.
        </p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="password">Пароль доступа</label>
          <div className="input-with-icon">
            <LockKeyhole size={18} aria-hidden="true" />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
              placeholder="Введите пароль"
            />
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button full" type="submit" disabled={busy}>
            {busy ? "Проверяем…" : "Войти"}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </form>
      </div>
    </main>
  );
}
