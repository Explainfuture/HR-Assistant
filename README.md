# Resume Copilot

Chrome Extension MVP for analyzing BOSS candidate resumes against a locally maintained JD knowledge base.

## Run Locally

1. Open Chrome Extensions: `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension` folder in this repository.
5. Open the extension Options page.
6. Save a DeepSeek API Key.
7. Paste a JD, generate a job profile JSON, edit if needed, and save it.
8. Open a BOSS candidate resume detail panel.
9. Open the extension side panel, select a job profile, and click `抓取并分析`.

## Validate

```bash
npm test
```

The validation script checks the MV3 manifest, required extension files, and the JSON parser behavior used for DeepSeek responses.
