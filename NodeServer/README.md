# Mockingbird: Core Framework Server

This directory contains the core algorithmic implementation of the Mockingbird framework. It is a Node.js application responsible for orchestrating the entire gray-box testing process.

## Core Functionality

The Mockingbird server performs the following key tasks:

1.  **Browser Automation**: It uses Playwright to launch and control a browser instance, navigating to the target web application.
2.  **Network Interception**: It leverages the Chrome DevTools Protocol (CDP) to intercept network requests, specifically for JavaScript files (`.js`) and HTML documents.
3.  **Dynamic Instrumentation**: It injects a custom JavaScript payload (`injected.js`) into the browser context. This payload hooks into browser APIs (`fetch`, `XHR`, `JSON.parse`) to wrap target API responses in `Proxy` objects.
4.  **Runtime Data Tracing**: The `Proxy` objects track every property access on the API response data. When an access occurs, it reports the call stack and access details back to this Node.js server.
5.  **Static Analysis & Code Rewriting**: Upon receiving a data access report, the server reads the corresponding local script file, uses Babel to parse it into an Abstract Syntax Tree (AST), and identifies the exact expression or statement responsible for the access.
6.  **Iterative Enhancement**: It adds the newly discovered data access points (variable assignments, return statements) to a watchlist (`wrapLists`). In the next iteration, it rewrites the JavaScript file's AST to wrap these expressions with a tracer function (`varProxy`), ensuring deeper data flow tracking in subsequent runs.

This "execute-analyze-rewrite" loop allows Mockingbird to progressively uncover the complete usage of an API's response data throughout the front-end codebase.

## File Structure

- **/tools/**: Contains the core logic modules.
  - `tools.js`: Houses all the static analysis functions using Babel (AST parsing, traversal, and code generation).
  - `injected.js`: The client-side JavaScript payload that is injected into the browser to perform dynamic data tracing with Proxies.
  - `command.js`: A module for executing automated browser actions defined in config files.
- **/configs/**: Contains configuration files that define the testing scenarios. Each `.config` file specifies the target URL, the target API to be traced, and a sequence of browser actions (e.g., `LOAD`, `CLICK`, `INPUT`).
- **/logs/**: The output directory where all testing artifacts are saved, including raw access logs, modified scripts, and analysis results.
- `ede-killer.js`: The main entry point of the server. It reads the configuration, launches the browser, and manages the iterative testing loop.

## Setup and Installation

1.  Navigate to this directory in your terminal:

    ```bash
    cd NodeServer
    ```

2.  Install the required Node.js dependencies:
    ```bash
    npm install
    ```

## How to Run

The framework is driven by configuration files.

1.  **Choose a Configuration**: Select a test case from the `/configs` directory (e.g., `shop.config`).

2.  **Run the Server**: Execute the main script from the command line, passing the name of the configuration file (without the `.config` extension) as an argument.

    ```bash
    node ede-killer.js <config_name>
    ```

    **Example**:

    ```bash
    node ede-killer.js test
    ```

3.  **Execution Process**:
    - A browser window will open and automatically perform the actions defined in the config file.
    - The console will display logs from the server and the browser.
    - The process will run in a loop, refining the code instrumentation in each cycle, until no new data access patterns are discovered.
    - All output, including the detailed `usevar.log`, will be saved to the corresponding directory under `/logs` (e.g., `/logs/test/`).
