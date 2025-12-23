"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const openai_1 = __importDefault(require("openai"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// Environment variables
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const USDA_API_KEY = process.env.USDA_API_KEY || "DEMO_KEY";
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute
// Simple rate limiting store
const requestCounts = new Map();
// Middleware
app.use((0, cors_1.default)()); // Allow all origins for development
app.use(express_1.default.json());
// Simple rate limiting middleware
const rateLimiter = (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const userLimit = requestCounts.get(ip);
    if (!userLimit || now > userLimit.resetTime) {
        requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        next();
    }
    else if (userLimit.count < MAX_REQUESTS_PER_WINDOW) {
        userLimit.count++;
        next();
    }
    else {
        res.status(429).json({
            error: "Too many requests. Please try again later.",
        });
    }
};
app.use(rateLimiter);
// Initialize Groq client
const groqClient = new openai_1.default({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});
const SYSTEM_PROMPT = `You are a nutrition analysis assistant. Your job is to analyze meal descriptions and provide accurate macro estimates.

When given a meal description:
1. Parse the ingredients and quantities
2. Break down the meal into individual food items
3. For each item, estimate its macronutrients separately
4. Convert all quantities to standardized measurements
5. Calculate totals across all items
6. Provide a clear description of what you interpreted
7. List any assumptions you made

IMPORTANT: Always break down meals into individual items. For example:
- "2 eggs with toast" should have 2 items: eggs and toast
- "chicken rice and broccoli" should have 3 items: chicken, rice, broccoli
- "peanut butter sandwich" should have 3 items: bread, peanut butter, (second slice of bread is part of bread item)

Return your response as a JSON object with this exact structure:
{
  "description": "Clear description of the meal",
  "items": [
    {
      "name": "Food item name",
      "quantity": "Amount with unit (e.g., '2 eggs', '150g', '1 cup')",
      "calories": number,
      "protein": number (in grams),
      "carbs": number (in grams),
      "fat": number (in grams)
    }
  ],
  "total_calories": number (sum of all items),
  "protein": number (sum of all items, in grams),
  "carbs": number (sum of all items, in grams),
  "fat": number (sum of all items, in grams),
  "confidence": "low" | "medium" | "high",
  "assumptions": ["assumption 1", "assumption 2"]
}

Only return the JSON object, no additional text.`;
// Routes
// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});
// Estimate meal macros using Groq AI
app.post("/api/estimate-meal", async (req, res) => {
    try {
        console.log("ARE WE HITTING THE ENDPOINT FOR AI SUMMARIZE?");
        console.log(GROQ_API_KEY);
        console.log(USDA_API_KEY);
        const { userInput } = req.body;
        if (!userInput || typeof userInput !== "string") {
            return res.status(400).json({
                error: "Invalid request. userInput is required and must be a string.",
            });
        }
        if (!GROQ_API_KEY) {
            return res.status(500).json({
                error: "Groq API key not configured on server",
            });
        }
        const completion = await groqClient.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT,
                },
                {
                    role: "user",
                    content: userInput,
                },
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.3,
            response_format: { type: "json_object" },
        });
        const responseContent = completion.choices[0]?.message?.content;
        if (!responseContent) {
            throw new Error("No response from AI service");
        }
        const parsed = JSON.parse(responseContent);
        // Validate the response structure
        if (typeof parsed.description !== "string" ||
            !Array.isArray(parsed.items) ||
            typeof parsed.total_calories !== "number" ||
            typeof parsed.protein !== "number" ||
            typeof parsed.carbs !== "number" ||
            typeof parsed.fat !== "number" ||
            !Array.isArray(parsed.assumptions)) {
            throw new Error("Invalid response format from AI service");
        }
        // Validate each item
        for (const item of parsed.items) {
            if (typeof item.name !== "string" ||
                typeof item.quantity !== "string" ||
                typeof item.calories !== "number" ||
                typeof item.protein !== "number" ||
                typeof item.carbs !== "number" ||
                typeof item.fat !== "number") {
                throw new Error("Invalid item format in AI response");
            }
        }
        // Round numbers for cleaner display
        const result = {
            ...parsed,
            items: parsed.items.map((item) => ({
                ...item,
                calories: Math.round(item.calories),
                protein: Math.round(item.protein * 10) / 10,
                carbs: Math.round(item.carbs * 10) / 10,
                fat: Math.round(item.fat * 10) / 10,
            })),
            total_calories: Math.round(parsed.total_calories),
            protein: Math.round(parsed.protein * 10) / 10,
            carbs: Math.round(parsed.carbs * 10) / 10,
            fat: Math.round(parsed.fat * 10) / 10,
        };
        res.json(result);
    }
    catch (error) {
        console.error("Error estimating meal macros:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Error estimating meal macros",
        });
    }
});
// Search foods in USDA database
app.get("/api/search-foods", async (req, res) => {
    try {
        console.log("USDA SEARCH BACKEND API IS WORKING!");
        const { query, pageSize = "10", pageNumber = "1" } = req.query;
        if (!query || typeof query !== "string") {
            return res.status(400).json({
                error: "Invalid request. query parameter is required.",
            });
        }
        const pageSizeNum = parseInt(pageSize, 10);
        const pageNumberNum = parseInt(pageNumber, 10);
        if (isNaN(pageSizeNum) ||
            isNaN(pageNumberNum) ||
            pageSizeNum < 1 ||
            pageNumberNum < 1) {
            return res.status(400).json({
                error: "Invalid pageSize or pageNumber parameters.",
            });
        }
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_API_KEY}&query=${encodeURIComponent(query)}&pageSize=${pageSizeNum}&pageNumber=${pageNumberNum}&dataType=Foundation,Survey (FNDDS)`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`USDA API Error: ${response.status}`);
        }
        const data = await response.json();
        res.json(data);
    }
    catch (error) {
        console.error("Error searching foods:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Error searching foods",
        });
    }
});
// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
