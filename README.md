# CCA Navigator

A clinical trial finder for cholangiocarcinoma patients and families. Built after losing my father to CCA — because finding and understanding trials shouldn't be this hard.

## What it does
- Searches active recruiting trials live from ClinicalTrials.gov
- Uses Claude to explain each trial in plain English (no jargon)
- Generates a personalized fit score and questions to bring to your oncologist
- Surfaces researcher contact info and a suggested outreach message
- Saves trials to revisit later

## Tech
- Node.js + Express backend
- Anthropic Claude API (claude-sonnet-4-6) for plain-language summaries
- ClinicalTrials.gov API v2 for live trial data
- Vanilla JS frontend, no frameworks

## Running locally
1. Clone the repo
2. Run `npm install`
3. Create a `.env` file with `ANTHROPIC_API_KEY=your-key`
4. Run `npm start` and open `http://localhost:3001`
