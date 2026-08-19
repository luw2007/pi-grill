/**
 * The grill badge + panel: one shell.overlay entry showing every live
 * interview, newest first, with the selected session's ledger and question.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { GrillQuestionView, GrillSessionView, GrillWireState } from "./port.ts";
import { createGrillPort } from "./port.ts";
import css from "./GrillOverlay.module.css";

export type GrillOverlayProps = { renderSlot?: unknown; __renders?: unknown };

const STATUS_LABEL: Record<string, string> = {
	pending: "pending",
	current: "current",
	answered: "answered",
	skipped: "skipped",
	deprecated: "deprecated",
	removed: "removed",
};

function openCount(session: GrillSessionView): number {
	return session.state.questions.filter((q) => q.status === "pending" || q.status === "current").length;
}

function totalOpen(wire: GrillWireState | null): number {
	return wire ? wire.sessions.reduce((sum, session) => sum + openCount(session), 0) : 0;
}

export function GrillOverlay(_props: GrillOverlayProps): ReactElement | null {
	const port = useMemo(() => createGrillPort(), []);
	const [wire, setWire] = useState<GrillWireState | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
	const [refining, setRefining] = useState(false);
	const [noteDraft, setNoteDraft] = useState("");
	const [textDraft, setTextDraft] = useState("");
	const [reasonDraft, setReasonDraft] = useState("");
	const [textOption, setTextOption] = useState<{ value: string; label: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const seenCurrent = useRef<Set<string>>(new Set());

	const refresh = async (): Promise<void> => {
		try {
			const next = await port.getState();
			setWire(next);
			// Auto-open the panel when a new batch makes a question current.
			const newest = next.sessions[0];
			if (newest) {
				const current = newest.state.questions.find((q) => q.status === "current");
				if (current && !seenCurrent.current.has(current.id)) {
					seenCurrent.current.add(current.id);
					setOpen(true);
					setSelectedSessionId(newest.sessionId);
					setSelectedQuestionId(current.id);
					setRefining(false);
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => {
		void refresh();
		const unsubscribe = port.subscribe(() => { void refresh(); });
		return unsubscribe;
	}, [port]);

	const sessions = wire?.sessions ?? [];
	const session = sessions.find((s) => s.sessionId === selectedSessionId) ?? sessions[0] ?? null;
	const questions = session?.state.questions ?? [];
	const selectedQuestion = questions.find((q) => q.id === selectedQuestionId) ?? questions.find((q) => q.status === "current") ?? questions.find((q) => q.status === "pending") ?? questions[0] ?? null;

	// Keep the selection valid: newest session by default, current/pending question by default.
	useEffect(() => {
		if (sessions.length === 0) return;
		if (!selectedSessionId || !sessions.some((s) => s.sessionId === selectedSessionId)) {
			setSelectedSessionId(sessions[0]!.sessionId);
		}
	}, [sessions, selectedSessionId]);

	useEffect(() => {
		const candidate = questions.find((q) => q.id === selectedQuestionId)
			?? questions.find((q) => q.status === "current")
			?? questions.find((q) => q.status === "pending")
			?? questions[0]
			?? null;
		if (candidate && candidate.id !== selectedQuestionId) setSelectedQuestionId(candidate.id);
	}, [questions, selectedQuestionId]);

	const run = async (action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> => {
		if (busy || !session) return;
		setBusy(true);
		setError(null);
		try {
			const result = await action();
			if (!result.ok) setError(result.message ?? "action failed");
			else {
				setTextDraft("");
				setReasonDraft("");
				setTextOption(null);
				setRefining(false);
				await refresh();
			}
		} finally {
			setBusy(false);
		}
	};

	const commitOption = (question: GrillQuestionView, option: { value: string; label: string }, other: boolean): void => {
		if (!session) return;
		void run(() => port.answer(session.sessionId, question.id, {
			value: option.value,
			label: option.label,
			index: 0,
			other,
			reason: reasonDraft.trim(),
		}, refining));
	};

	const optionsFor = (question: GrillQuestionView): { value: string; label: string; description?: string; requiresText?: boolean }[] => [
		...question.options.map((o) => ({ value: o.value, label: o.label, description: o.description, requiresText: o.requiresText })),
		{ value: "__other__", label: "Something else (type it)" },
	];

	const onSubmitNote = (event: FormEvent): void => {
		event.preventDefault();
		if (!session || !noteDraft.trim()) return;
		const text = noteDraft;
		setNoteDraft("");
		void run(() => port.note(session.sessionId, text));
	};

	const badgeCount = totalOpen(wire);

	return (
		<>
			<button
				type="button"
				className={css.badge}
				onClick={() => setOpen((value) => !value)}
				title="Grill interviews"
			>
				<span className={css.badgeIcon}>🍖</span>
				{badgeCount > 0 && <span className={css.badgeCount}>{badgeCount}</span>}
			</button>
			{open && session && (
				<div className={css.panel} role="dialog" aria-label="Grill interview panel">
					<header className={css.header}>
						<div className={css.title}>
							<strong>Grill</strong>
							<span className={css.subtitle}>
								{session.state.content} · answered {session.state.answeredCount} / active {session.state.validQuestionCount}
							</span>
						</div>
						{sessions.length > 1 && (
							<select
								className={css.sessionSelect}
								value={session.sessionId}
								onChange={(event) => {
									setSelectedSessionId(event.target.value);
									setSelectedQuestionId(null);
									setRefining(false);
								}}
							>
								{sessions.map((s) => (
									<option key={s.sessionId} value={s.sessionId}>
										{s.state.content} ({s.sessionId.slice(0, 8)})
									</option>
								))}
							</select>
						)}
						<button type="button" className={css.close} onClick={() => setOpen(false)} aria-label="Close">×</button>
					</header>
					<div className={css.body}>
						<nav className={css.ledger} aria-label="Questions">
							{questions.length === 0 && <p className={css.empty}>No questions yet — the agent publishes them with grill_ask.</p>}
							{questions.map((q) => {
								const active = q.id === selectedQuestion?.id;
								const answerable = q.status === "pending" || q.status === "current" || q.status === "answered" || q.status === "skipped";
								return (
									<button
										key={q.id}
										type="button"
										className={css.ledgerRow + " " + css["status-" + q.status] + (active ? " " + css.activeRow : "")}
										onClick={() => {
											setSelectedQuestionId(q.id);
											setRefining(q.status === "answered" || q.status === "skipped");
											setTextDraft("");
											setReasonDraft("");
											setTextOption(null);
										}}
									>
										<span className={css.rowStatus}>{STATUS_LABEL[q.status] ?? q.status}</span>
										<span className={css.rowQuestion}>{q.question}</span>
										{q.userChoice && <span className={css.rowChoice}>{q.userChoice}</span>}
									</button>
								);
							})}
							{refining && <p className={css.refineHint}>Re-answering: the previous answer will be kept as deprecated.</p>}
						</nav>
						<section className={css.answer} aria-label="Question">
							{!selectedQuestion && <p className={css.empty}>Select a question from the ledger.</p>}
							{selectedQuestion && (
								<article key={selectedQuestion.id}>
									<header className={css.questionHeader}>
										<code>{selectedQuestion.id}</code>
										<span className={css.statusPill + " " + css["status-" + selectedQuestion.status]}>{STATUS_LABEL[selectedQuestion.status] ?? selectedQuestion.status}</span>
									</header>
									<h3 className={css.questionText}>{selectedQuestion.question}</h3>
									{selectedQuestion.context && <p className={css.context}>{selectedQuestion.context}</p>}
									{selectedQuestion.recommendationReason && <p className={css.recommendation}>Recommended because: {selectedQuestion.recommendationReason}</p>}
									{selectedQuestion.status === "answered" && selectedQuestion.userChoice && (
										<p className={css.choice}>Answer: {selectedQuestion.userChoice}{selectedQuestion.reason ? " — " + selectedQuestion.reason : ""}</p>
									)}
									{selectedQuestion.statusNote && <p className={css.statusNote}>{selectedQuestion.statusNote}</p>}
									<div className={css.options}>
										{optionsFor(selectedQuestion).map((option) => {
											const recommended = selectedQuestion.recommended !== undefined && option.value === selectedQuestion.recommended;
											return (
												<button
													key={option.value}
													type="button"
													className={css.option + (recommended ? " " + css.recommendedOption : "")}
													disabled={busy}
													onClick={() => {
														if (option.requiresText || option.value === "__other__") {
															setTextOption({ value: option.value, label: option.label });
															return;
														}
														commitOption(selectedQuestion, option, false);
													}}
												>
													<span>{option.label}</span>
													{recommended && <span className={css.recommendedTag}>Recommended</span>}
													{option.description && <small className={css.optionDescription}>{option.description}</small>}
												</button>
											);
										})}
									</div>
									{textOption && (
										<form
											className={css.textForm}
											onSubmit={(event) => {
												event.preventDefault();
												if (!textDraft.trim()) return;
												const label = textOption.value === "__other__" ? textDraft.trim() : textOption.label;
												commitOption(selectedQuestion, { value: textOption.value === "__other__" ? "__other__" : textOption.value, label }, textOption.value === "__other__");
											}}
										>
											<input
													className={css.textInput}
													value={textDraft}
													autoFocus
													placeholder={textOption.value === "__other__" ? "Type your own answer…" : "Type the required text…"}
													onChange={(event) => setTextDraft(event.target.value)}
												/>
											<button type="submit" className={css.primaryButton} disabled={!textDraft.trim() || busy}>Commit</button>
											<button type="button" className={css.ghostButton} onClick={() => setTextOption(null)}>Cancel</button>
										</form>
									)}
									<div className={css.actions}>
										{(selectedQuestion.status === "pending" || selectedQuestion.status === "current" || selectedQuestion.status === "answered" || selectedQuestion.status === "skipped") && (
											<button
												type="button"
												className={css.ghostButton}
												disabled={busy}
												onClick={() => { void run(() => port.skip(session.sessionId, selectedQuestion.id)); }}
											>
												Skip
											</button>
										)}
										{selectedQuestion.status === "answered" && !refining && (
											<button type="button" className={css.ghostButton} onClick={() => setRefining(true)}>Re-answer</button>
										)}
										{refining && selectedQuestion.status === "answered" && (
											<button type="button" className={css.ghostButton} onClick={() => setRefining(false)}>Cancel re-answer</button>
										)}
									</div>
									<label className={css.reasonLabel}>
										Reason (optional)
										<input
											className={css.textInput}
											value={reasonDraft}
											placeholder="Why this choice? Sent to the agent with the answer."
											onChange={(event) => setReasonDraft(event.target.value)}
										/>
									</label>
								</article>
							)}
						</section>
					</div>
					<form className={css.noteBar} onSubmit={onSubmitNote}>
						<input
							className={css.textInput}
							value={noteDraft}
							placeholder="Note for the agent (not tied to a question)…"
							onChange={(event) => setNoteDraft(event.target.value)}
						/>
						<button type="submit" className={css.primaryButton} disabled={!noteDraft.trim() || busy}>Send note</button>
					</form>
					{error && <p className={css.error}>{error}</p>}
				</div>
			)}
		</>
	);
}