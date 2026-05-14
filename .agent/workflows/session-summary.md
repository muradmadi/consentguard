---
description: Automatically generating a summary of the previous AI session's changes and decisions.
---
# Workflow: Session Summary Generation

## Context
At the end of an AI session, it is critical to document the progress, technical decisions, and file changes made. This ensures continuity and provides a clear audit trail for both the user and the agent in future sessions.

## Steps

### 1. Analyze Previous Session Logs
*   Review the `overview.txt` of the current or previous conversation (found in the `brain` directory).
*   Identify key technical decisions made and their rationale.
*   Note all files created, modified, or deleted.

### 2. Generate the Summary Document
*   Use the naming convention `YYYY-MM-DD_HH-MM-SS.md`.
*   Place the file in `.agent/previous/`.
*   Include the following sections:
    *   **Header**: Title of the session and the exact timestamp.
    *   **Summary of Actions**: A high-level overview of what was accomplished.
    *   **Technical Decisions & Rationale**: Detail why certain choices were made (e.g., choice of libraries, architectural patterns).
    *   **Changed Files List**: A bulleted list of all files impacted.
    *   **Verification**: How the changes were tested and validated.

### 3. Maintain the "Why"
*   Focus on explaining the *reasoning* behind the code, not just what the code does. This aligns with the "Why" mandate of the project.

---
**Usage**: Run this workflow at the end of every significant session or when prompted by the user to "close the session".
