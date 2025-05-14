# Node-Against-Humanity
A modern, good-looking NodeJS based Cards Against Humanity game server with support for JSON Against Humanity sets!

## Selfhosting Instructions

1. Clone the repository:
   ```bash
   git clone https://github.com/WendellTech/Node-Against-Humanity
   cd Node-Against-Humanity
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure (optional):
   Edit the `config.json` file to customize your server settings:
   ```json
   {
     "allowSameNames": false,
     "roomsFunctionality": true
   }
   ```
   - `allowSameNames`: When false, prevents players with the same name from joining a lobby.
   - `roomsFunctionality`: When true, enables the public room listing feature.

4. Start the server:
   ```bash
   npm start
   ```

5. Access the game:
   - Open your browser and navigate to `http://localhost:3000`.
