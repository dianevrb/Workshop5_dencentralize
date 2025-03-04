import bodyParser from "body-parser";
import express from "express";
import http from "http";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

type NodeState = {
  killed: boolean;         // Indique si le noeud a été stoppé via la route /stop
  x: 0 | 1 | "?" | null;    // Valeur courante de consensus
  decided: boolean | null;  // Statut de décision finale
  k: number | null;         // Numéro de l’étape courante
};

export async function node(
  nodeId: number,             // Identifiant du noeud
  N: number,                  // Nombre total de noeuds
  F: number,                  // Nombre de noeuds défaillants autorisés
  initialValue: Value,        // Valeur initiale du noeud
  isFaulty: boolean,          // Indique si le noeud est défaillant
  nodesAreReady: () => boolean, // Fonction indiquant si tous les noeuds sont prêts
  setNodeIsReady: (index: number) => void // Fonction à appeler lorsque le noeud est prêt
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  // État initial du noeud
  const nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // Map pour stocker les propositions reçues (phase "decision")
  const proposals = new Map<number, Value[]>();
  // Map pour enregistrer les messages finaux (phase "final")
  const finalDecisions = new Map<number, Value[]>();

  // Route GET /status : renvoie "live" si le noeud est opérationnel, sinon "faulty"
  app.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  // Route GET /getState : renvoie l'état courant du noeud
  app.get("/getState", (req, res) => {
    res.status(200).json(nodeState);
  });

  // Route POST /message : gestion de la réception des messages de consensus
  app.post("/message", (req, res) => {
    const { k, x, messageType } = req.body;

    if (isFaulty) {
      nodeState.k = null;
      nodeState.x = null;
      nodeState.decided = null;
      return res.status(500).json({ message: `Node ${nodeId} is faulty` });
    }
    if (nodeState.killed) {
      return res.status(500).json({ message: `Node ${nodeId} is stopped` });
    }

    // Gestion du message de type "decision" (phase 0)
    if (messageType === "decision") {
      if (!proposals.has(k)) {
        proposals.set(k, []);
      }
      proposals.get(k)!.push(x);
      const currentProps = proposals.get(k)!;
      if (currentProps.length >= (N - F)) {
        const count0 = currentProps.filter(val => val === 0).length;
        const count1 = currentProps.filter(val => val === 1).length;
        let newValue: Value = "?";
        if (count0 > (N / 2)) {
          newValue = 0;
        } else if (count1 > (N / 2)) {
          newValue = 1;
        }
        // Diffuse un message final à tous les noeuds
        for (let i = 0; i < N; i++) {
          broadcastMessage(
            `http://localhost:${BASE_NODE_PORT + i}/message`,
            { k, x: newValue, messageType: "final" }
          );
        }
        return res.status(200).json({ message: "Phase 0 completed" });
      }
    }
    // Gestion du message de type "final" (phase 1)
    else if (messageType === "final") {
      if (!finalDecisions.has(k)) {
        finalDecisions.set(k, []);
      }
      finalDecisions.get(k)!.push(x);
      const currentFinals = finalDecisions.get(k)!;
      if (currentFinals.length >= (N - F)) {
        const zeros = currentFinals.filter(val => val === 0).length;
        const ones = currentFinals.filter(val => val === 1).length;
        if (ones >= F + 1 || zeros >= F + 1) {
          nodeState.x = ones >= zeros ? 1 : 0;
          nodeState.decided = true;
        } else {
          nodeState.x = zeros + ones > 0 ? (zeros > ones ? 0 : 1) : (Math.random() > 0.5 ? 1 : 0);
          nodeState.k = k + 1;
          // Diffuse un nouveau message decision pour la prochaine étape
          for (let i = 0; i < N; i++) {
            broadcastMessage(
              `http://localhost:${BASE_NODE_PORT + i}/message`,
              { k: nodeState.k, x: nodeState.x, messageType: "decision" }
            );
          }
          return res.status(200).json({ message: "Phase 1 completed" });
        }
      }
    }
    return res.status(500).json({ message: `Error processing message at Node ${nodeId}` });
  });

  // Route GET /start : lance l'algorithme de consensus
  app.get("/start", async (req, res) => {
    // Attendre que tous les noeuds soient prêts
    while (!nodesAreReady()) {}
    if (isFaulty) {
      nodeState.k = null;
      nodeState.x = null;
      nodeState.decided = null;
      return res.status(500).json({ message: `Node ${nodeId} is faulty` });
    }
    nodeState.k = 1;
    nodeState.x = initialValue;
    nodeState.decided = false;
    // Diffuse le premier message "decision" à tous les noeuds
    for (let i = 0; i < N; i++) {
      broadcastMessage(
        `http://localhost:${BASE_NODE_PORT + i}/message`,
        { k: nodeState.k, x: nodeState.x, messageType: "decision" }
      );
    }
    return res.status(200).send("Consensus algorithm initiated.");
  });

  // Route GET /stop : arrête toute activité du noeud
  app.get("/stop", async (req, res) => {
    nodeState.killed = true;
    return res.status(200).send(`Node ${nodeId} has been stopped.`);
  });

  // Fonction utilitaire pour diffuser un message via une requête HTTP POST
  function broadcastMessage(url: string, body: any) {
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(url, options, (resp) => {
      let data = "";
      resp.on("data", (chunk) => {
        data += chunk;
      });
      resp.on("end", () => {
        try {
          if (resp.headers["content-type"]?.includes("application/json")) {
            JSON.parse(data);
          }
        } catch (error) {
          // Ignorer les erreurs de parsing
        }
      });
    });
    req.on("error", (err) => {
      // Gestion minimale des erreurs
    });
    req.write(JSON.stringify(body));
    req.end();
  }

  // Démarrage du serveur sur le port BASE_NODE_PORT + nodeId
  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} is active on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
