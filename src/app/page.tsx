"use client";

import React, { useState, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

// Types
interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswers: string[];
  explanation: string;
}

type Phase = "upload" | "config" | "generating" | "quiz" | "result" | "review";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [file, setFile] = useState<File | null>(null);

  // PDF Chunking States
  const [pdfParts, setPdfParts] = useState<{ label: string; text: string }[]>([]);
  const [selectedPartIndex, setSelectedPartIndex] = useState<number>(0);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  // Config State
  const [difficulty, setDifficulty] = useState("Moyen");
  const [questionCount, setQuestionCount] = useState<number>(10);
  const [questionType, setQuestionType] = useState<"radio" | "checkbox">("radio");

  // Quiz State
  const [questionQueue, setQuestionQueue] = useState<QuizQuestion[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Scoring / Logic State
  const [failedQuestions, setFailedQuestions] = useState<QuizQuestion[]>([]);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [score, setScore] = useState(0);

  // Dark Mode Theme toggle
  const [darkMode, setDarkMode] = useState(true);

  // --- NOUVEAU : Restauration depuis localStorage ---
  useEffect(() => {
    const saved = localStorage.getItem("quiz_app_state");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (["quiz", "result", "review"].includes(parsed.phase)) {
          setPhase(parsed.phase);
          setQuestionQueue(parsed.questionQueue || []);
          setTotalQuestions(parsed.totalQuestions || 0);
          setFailedQuestions(parsed.failedQuestions || []);
          setScore(parsed.score || 0);
          setDifficulty(parsed.difficulty || "Moyen");
        }
      } catch (e) {
        console.error("Erreur de parsing localStorage", e);
      }
    }
  }, []);

  // --- NOUVEAU : Sauvegarde automatique dans localStorage ---
  useEffect(() => {
    if (["quiz", "result", "review"].includes(phase)) {
      localStorage.setItem("quiz_app_state", JSON.stringify({
        phase,
        questionQueue,
        totalQuestions,
        failedQuestions,
        score,
        difficulty
      }));
    }
  }, [phase, questionQueue, totalQuestions, failedQuestions, score, difficulty]);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setPhase("config");
      setIsAnalyzing(true);
      setError(null);

      try {
        // Configuration du Worker exécutée uniquement côté client
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
        }

        const arrayBuffer = await f.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        
        const PAGES_PER_CHUNK = 20;
        let currentChunkText = "";
        let startPage = 1;
        const newPdfParts: { label: string; text: string }[] = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          // @ts-ignore
          const pageText = textContent.items.map((item) => item.str || "").join(" ");

          currentChunkText += pageText + "\n";

          // Libérer la mémoire pour éviter de saturer la RAM sur mobile (Safari)
          page.cleanup();

          // Découpage strict toutes les 20 pages ou à la fin du document
          if (i % PAGES_PER_CHUNK === 0 || i === pdf.numPages) {
            const partNumber = newPdfParts.length + 1;
            const label = startPage === i
              ? `Partie ${partNumber} (Page ${startPage})`
              : `Partie ${partNumber} (Pages ${startPage} à ${i})`;

            newPdfParts.push({
              label,
              text: currentChunkText
            });

            currentChunkText = "";
            startPage = i + 1;
          }
        }

        setPdfParts(newPdfParts);
        setSelectedPartIndex(0);
      } catch (err: any) {
        console.error("Erreur PDF:", err);
        setError("Erreur matérielle ou de lecture du PDF : " + (err.message || err));
        setPhase("upload");
      } finally {
        setIsAnalyzing(false);
      }
    }
  };

  const generateQuiz = async () => {
    if (pdfParts.length === 0) return;
    setPhase("generating");
    setError(null);

    try {
      const textToSend = pdfParts[selectedPartIndex].text;

      if (!textToSend || textToSend.trim() === "") {
        throw new Error("Impossible d'extraire le texte de cette partie.");
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: textToSend,
          difficulty,
          questionCount,
          questionType
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur de génération");

      setQuestionQueue(data.questions);
      setTotalQuestions(data.questions.length);
      setPhase("quiz");
    } catch (err: any) {
      setError(err.message);
      setPhase("config");
    }
  };

  const handleOptionToggle = (option: string) => {
    if (questionType === "radio") {
      setSelectedOptions([option]);
    } else {
      setSelectedOptions((prev) =>
        prev.includes(option)
          ? prev.filter((o) => o !== option)
          : [...prev, option]
      );
    }
  };

  const submitAnswer = () => {
    const currentQ = questionQueue[0];
    if (!currentQ) return;

    // Check if correct
    const isCorrect =
      selectedOptions.length === currentQ.correctAnswers.length &&
      [...selectedOptions].sort().every((v, i) => v === [...currentQ.correctAnswers].sort()[i]);

    let newQueue = [...questionQueue];

    if (isCorrect) {
      newQueue.shift(); // Remove definitely

      // If it's the first try (not in failedQuestions)
      const hasFailedBefore = failedQuestions.some((fq) => fq.question === currentQ.question);
      if (!hasFailedBefore) {
        setScore((prev) => prev + 1);
      }
    } else {
      // Wrong answer
      newQueue.shift();
      newQueue.push(currentQ); // Move to the end

      // Add to failedQuestions if not present
      setFailedQuestions((prev) => {
        if (!prev.some((fq) => fq.question === currentQ.question)) {
          return [...prev, currentQ];
        }
        return prev;
      });
    }

    setQuestionQueue(newQueue);
    setSelectedOptions([]); // Reset selections automatically

    // Si queue vide, on a fini
    if (newQueue.length === 0) {
      setPhase("result");
    }
  };

  const resetApp = () => {
    localStorage.removeItem("quiz_app_state");
    setPhase("upload");
    setFile(null);
    setPdfParts([]);
    setSelectedPartIndex(0);
    setIsAnalyzing(false);
    setQuestionQueue([]);
    setTotalQuestions(0);
    setFailedQuestions([]);
    setSelectedOptions([]);
    setScore(0);
    setError(null);
  };

  return (
    <div className="flex flex-col h-full space-y-8 animate-in fade-in duration-500 pb-12">
      <header className="flex justify-between items-center bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
        <h1 className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
          QuizAI Generator
        </h1>
        <div className="flex items-center space-x-3">
          {phase !== "upload" && (
            <button
              onClick={resetApp}
              className="px-3 py-2 text-sm font-bold text-red-600 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/50 rounded-lg transition"
            >
              Quitter
            </button>
          )}
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 bg-gray-100 dark:bg-gray-700 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 transition"
          >
            {darkMode ? "☀️ Clair" : "🌙 Sombre"}
          </button>
        </div>
      </header>

      <div className="flex-1 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 overflow-hidden">

        {/* PHASE: UPLOAD */}
        {phase === "upload" && (
          <div className="p-12 text-center flex flex-col items-center space-y-6">
            <h2 className="text-3xl font-bold">Importez votre module PDF</h2>
            <p className="text-gray-500 dark:text-gray-400 max-w-lg">
              Chargez vos cours au format PDF pour générer des quiz d'entraînement sur-mesure grâce à l'intelligence artificielle.
            </p>
            {error && (
              <div className="w-full max-w-md p-4 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 font-semibold border border-red-300 dark:border-red-800 rounded-lg">
                Erreur : {error}
              </div>
            )}
            <div className="w-full max-w-md mt-6 relative border-2 border-dashed border-indigo-300 dark:border-indigo-600 bg-indigo-50 dark:bg-gray-900 rounded-xl p-8 hover:bg-indigo-100 dark:hover:bg-gray-800 transition">
              <input
                type="file"
                accept="application/pdf"
                onChange={handleUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <span className="text-indigo-600 dark:text-indigo-400 font-semibold cursor-pointer">
                Cliquez ou glissez un fichier PDF ici
              </span>
            </div>
          </div>
        )}

        {/* PHASE: CONFIG - ANALYZING */}
        {phase === "config" && isAnalyzing && (
          <div className="p-16 text-center space-y-6 flex flex-col items-center">
            <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            <h2 className="text-2xl font-bold animate-pulse">Analyse du PDF en cours...</h2>
            <p className="text-gray-500">Découpage intelligent en sections logiques pour optimiser l'intelligence artificielle.</p>
          </div>
        )}

        {/* PHASE: CONFIG - OPTIONS */}
        {phase === "config" && !isAnalyzing && (
          <div className="p-8 max-w-2xl mx-auto space-y-8">
            <h2 className="text-3xl font-bold text-center">Configuration du Quiz</h2>
            {error && <div className="p-4 bg-red-100 text-red-700 rounded-lg text-center">{error}</div>}

            <div className="space-y-6">
              
              {pdfParts.length > 0 && (
                <div className="mb-6 p-6 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl border border-indigo-200 dark:border-indigo-800">
                  <h3 className="block text-sm font-semibold mb-3 text-indigo-900 dark:text-indigo-200">
                    Document analysé ({pdfParts.length} partie{pdfParts.length > 1 ? "s" : ""}). Choisissez la section à réviser :
                  </h3>
                  <select
                    value={selectedPartIndex}
                    onChange={(e) => setSelectedPartIndex(Number(e.target.value))}
                    className="w-full p-3 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 font-medium"
                  >
                    {pdfParts.map((part, index) => (
                      <option key={index} value={index}>
                        {part.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold mb-2">Niveau de difficulté</label>
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                  className="w-full p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700"
                >
                  <option>Facile</option>
                  <option>Moyen</option>
                  <option>Difficile</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Nombre de questions</label>
                <input
                  type="number"
                  min="1" max="50"
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Number(e.target.value))}
                  className="w-full p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Type de question</label>
                <div className="flex space-x-4">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="radio"
                      name="qtype"
                      checked={questionType === "radio"}
                      onChange={() => setQuestionType("radio")}
                      className="w-5 h-5 text-indigo-600"
                    />
                    <span>Choix unique (Radio)</span>
                  </label>
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="radio"
                      name="qtype"
                      checked={questionType === "checkbox"}
                      onChange={() => setQuestionType("checkbox")}
                      className="w-5 h-5 text-indigo-600"
                    />
                    <span>Choix multiples (Cases à cocher)</span>
                  </label>
                </div>
              </div>

              <div className="pt-4">
                <button
                  onClick={generateQuiz}
                  className="w-full py-4 text-lg font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg transition transform hover:-translate-y-1"
                >
                  Générer le Quiz maintenant
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PHASE: GENERATING */}
        {phase === "generating" && (
          <div className="p-16 text-center space-y-6 flex flex-col items-center">
            <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            <h2 className="text-2xl font-bold animate-pulse">L'Intelligence Artificielle crée votre quiz...</h2>
            <p className="text-gray-500">Génération automatique des correctifs en cours.</p>
          </div>
        )}

        {/* PHASE: QUIZ */}
        {phase === "quiz" && questionQueue.length > 0 && (
          <div className="p-8 max-w-3xl mx-auto">
            <div className="flex justify-between items-center mb-8">
              <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">
                {questionQueue.length} question(s) restante(s) dans la pile
              </span>
              <span className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold">
                {difficulty}
              </span>
            </div>

            <h3 className="text-2xl font-bold mb-8 leading-snug">
              {questionQueue[0].question}
            </h3>

            <div className="space-y-4 mb-8">
              {questionQueue[0].options.map((opt, i) => {
                const isSelected = selectedOptions.includes(opt);

                return (
                  <button
                    key={i}
                    onClick={() => handleOptionToggle(opt)}
                    className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 
                      ${isSelected ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30" : "border-gray-200 dark:border-gray-700 hover:border-indigo-300"}
                    `}
                  >
                    <div className="flex items-center space-x-3">
                      <div className={`w-5 h-5 flex-shrink-0 flex items-center justify-center border rounded ${questionType === "radio" ? "rounded-full" : "rounded-md"} 
                        ${isSelected ? "border-indigo-500 bg-indigo-500" : "border-gray-400"}
                      `}>
                        {isSelected && <div className="w-2.5 h-2.5 bg-white rounded-full"></div>}
                      </div>
                      <span>{opt}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* ACTIONS */}
            <div className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-700">
              <button
                onClick={submitAnswer}
                disabled={selectedOptions.length === 0}
                className="w-full py-4 text-center font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition"
              >
                Valider
              </button>
            </div>
          </div>
        )}

        {/* PHASE: RESULT */}
        {phase === "result" && (
          <div className="p-12 text-center space-y-8">
            <h2 className="text-4xl font-extrabold text-indigo-600 dark:text-indigo-400">
              Quiz Terminé !
            </h2>

            <div className="inline-block p-8 bg-gray-50 dark:bg-gray-800 border-4 border-indigo-100 dark:border-indigo-900 rounded-full shadow-inner">
              <div className="text-6xl font-black text-gray-800 dark:text-white mb-2">
                {score} <span className="text-3xl text-gray-400">/ {totalQuestions}</span>
              </div>
              <p className="font-semibold text-gray-500">Score de réussite au premier essai</p>
            </div>

            <p className="max-w-md mx-auto text-lg text-gray-600 dark:text-gray-300">
              Vous avez fini par trouver toutes les bonnes réponses grâce à la répétition espacée, bravo !
            </p>

            <div className="pt-8 flex flex-col md:flex-row items-center justify-center gap-4">
              {failedQuestions.length > 0 && (
                <button
                  onClick={() => setPhase("review")}
                  className="px-8 py-4 bg-yellow-500 hover:bg-yellow-600 text-white font-bold rounded-xl shadow transition transform"
                >
                  Voir mes erreurs et explications
                </button>
              )}
              <button
                onClick={resetApp}
                className="px-8 py-4 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-900 font-bold rounded-xl shadow transition transform"
              >
                📝 Nouveau Quiz
              </button>
            </div>
          </div>
        )}

        {/* PHASE: REVIEW */}
        {phase === "review" && (
          <div className="p-8 max-w-4xl mx-auto space-y-8 pb-12">
            <h2 className="text-3xl font-bold text-center mb-6">Vos erreurs à réviser</h2>

            <div className="space-y-6">
              {failedQuestions.map((fq, index) => (
                <div key={index} className="p-6 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/50 rounded-xl space-y-4">
                  <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">
                    <span className="text-red-500 mr-2">Q{index + 1}.</span> {fq.question}
                  </h3>

                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-100 dark:border-gray-700">
                    <h4 className="font-semibold text-green-600 dark:text-green-400 mb-2">Bonne(s) réponse(s) :</h4>
                    <ul className="list-disc list-inside ml-4 text-gray-700 dark:text-gray-300 mb-4 font-medium">
                      {fq.correctAnswers.map((ans, i) => (
                        <li key={i}>{ans}</li>
                      ))}
                    </ul>

                    <h4 className="font-semibold text-blue-600 dark:text-blue-400 mb-2 mt-4">Explication pédagogique :</h4>
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed italic border-l-4 border-blue-400 pl-4 py-1">
                      "{fq.explanation}"
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-8 text-center border-t border-gray-200 dark:border-gray-700 mt-8">
              <button
                onClick={resetApp}
                className="px-8 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow transition"
              >
                Retour à l'accueil
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}