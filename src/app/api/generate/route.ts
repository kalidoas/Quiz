import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const windowMs = 60 * 60 * 1000; // 1 heure
const maxRequests = 10;
const rateLimitMap = new Map<string, { count: number, resetTime: number }>();

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';

    const now = Date.now();
    let clientData = rateLimitMap.get(ip);

    if (!clientData || now > clientData.resetTime) {
      clientData = { count: 0, resetTime: now + windowMs };
    }

    clientData.count++;
    rateLimitMap.set(ip, clientData);

    if (clientData.count > maxRequests) {
      return NextResponse.json({
        error: "Limite atteinte. Veuillez patienter pour générer de nouveaux quiz.",
        resetTime: clientData.resetTime
      }, { status: 429 });
    }

    const { text, difficulty, questionCount, questionType } = await req.json();

    if (!text || text.trim().length === 0) {
      return NextResponse.json({ error: "Le texte fourni est vide ou invalide." }, { status: 400 });
    }

    // Initialisation Gemini API : Assurez-vous d'avoir déclaré GEMINI_API_KEY dans le .env
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "dummy_key");
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const prompt = `
Vous êtes un expert en création de quiz pédagogiques. 
Générez un quiz structuré à partir du texte fourni.

Configuration :
- Niveau de difficulté : ${difficulty}
- Nombre de questions : ${questionCount}
- Type de question : ${questionType === "radio" ? "Choix unique" : "Choix multiples"}
- Options par question : STRICTEMENT 4 options.

Règles pour le JSON :
- Fournissez STRICTEMENT un objet JSON. 
- L'objet doit avoir une clé "questions" contenant un tableau d'objets.
- Structure d'un objet question :
  {
    "question": "Texte de la question en français",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctAnswers": ["Option correcte 1"], 
    "explanation": "Explication pédagogique détaillée en français justifiant la ou les bonnes réponses."
  }
Note pour "correctAnswers": il peut y en avoir plusieurs si "Choix multiples". Le texte exact de la réponse correcte doit être dans "options".

Texte source (limité aux premiers 50000 caractères) :
"""
${text.substring(0, 50000)}
"""
`;

    // Récupération de la donnée depuis l'API Google Gemini
    let result;
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        result = await model.generateContent(prompt);
        break;
      } catch (error: any) {
        attempt++;
        if (error?.status === 503 && attempt < maxRetries) {
          console.warn(`Erreur 503, tentative ${attempt}/${maxRetries} dans 2 secondes...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw error;
        }
      }
    }

    if (!result) throw new Error("Échec de la génération après plusieurs tentatives.");

    const content = result.response.text();

    if (!content) throw new Error("Réponse de l'IA vide.");

    const json = JSON.parse(content);

    return NextResponse.json({
      success: true,
      questions: json.questions
    });

  } catch (error: any) {
    console.error("API Route Error:", error);
    return NextResponse.json({ error: error.message || "Erreur interne du serveur." }, { status: 500 });
  }
}