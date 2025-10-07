# Vue.js Demo Application for Mockingbird

This directory contains a sample front-end application built with Vue.js. It is designed to work with the `/FlaskServerDemo` back-end to demonstrate the capabilities of the Mockingbird framework.

## Setup and Installation

Before running the application, you need to install the required Node.js dependencies.

1.  Navigate to this directory in your terminal:

    ```bash
    cd VueDemo
    ```

2.  Install the dependencies using `npm`:
    ```bash
    npm install
    ```

## Running the Development Server

Once the installation is complete, you can start the local development server.

```bash
npm run dev
```

The application will typically be available at `http://localhost:5173`. The server will automatically reload if you make any changes to the source files.

## Functionality

This application serves as a realistic testbed for Mockingbird. It makes various API calls to the Flask back-end, including calls to both documented and undocumented endpoints, allowing for a comprehensive demonstration of the framework's API discovery and testing features.
