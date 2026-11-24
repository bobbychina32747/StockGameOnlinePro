/** JSON limit for game API requests. */
export function installJsonBodies(app: { use: (...args: any[]) => any }): void {
    const express = require('express');
    app.use(express.json({ limit: '1mb' }));
}
