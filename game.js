const canvas = document.createElement("canvas");
canvas.id = "renderCanvas";
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.display = "block";
document.body.appendChild(canvas);

const engine = new BABYLON.Engine(canvas, true);

// Global variables
let scene;
let gameState = 'menu'; // 'menu', 'coinToss', 'game', 'win', 'lose'
let playerTeam = null; // 'red' or 'blue'
let chaseTeam = null; // 'red' or 'blue'
let runTeam = null; // opposite
let player = null;
let characters = [];
let uiManager = null;
let map = null;
let timer = 360; // 6 minutes in seconds - longer gameplay
let startTime = 0;
let gameUICreated = false;
let timerTextUI = null;
let roleTextUI = null;
let teamTextUI = null;
let playersTextUI = null;
let lockedTextUI = null;
let statusTextUI = null;

// Preloaded Assets
let idleAssetContainer = null;
let runAssetContainer = null;

// UI Styles
const UI_STYLES = {
    fontFamily: "'Outfit', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    titleFontSize: 56,
    subtitleFontSize: 22,
    bodyFontSize: 18,
    hudFontSize: 24,
    colors: {
        primary: "#ffffff",
        secondary: "#9db8d3",
        accent: "#f7d070",
        red: "#ff4d4d",
        blue: "#4d94ff",
        background: "rgba(10, 20, 40, 0.85)",
        border: "rgba(255, 255, 255, 0.2)",
        buttonRed: "#d63f4d",
        buttonBlue: "#3461af"
    },
    cornerRadius: 24,
    padding: "30px"
};

// Constants
const TEAM_RED = 'red';
const TEAM_BLUE = 'blue';
const ROLE_CHASE = 'chase';
const ROLE_RUN = 'run';

const GRAVITY = -0.018;
const JUMP_FORCE = 0.55;
const FALL_DEATH_Y = -200; // If a character falls below this, respawn them
const START_DELAY = 3; // Seconds before the round becomes active

// Arena boundary (set after map loads)
let arenaBounds = { minX: -200, maxX: 200, minZ: -200, maxZ: 200, groundY: -50 };
let mapMeshes = []; // All collidable map meshes for raycasting

const createScene = async () => {
    scene = new BABYLON.Scene(engine);

    // Camera (AAA-style 3rd person)
    const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 20, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 5;
    camera.upperRadiusLimit = 50;
    camera.wheelPrecision = 50;
    camera.checkCollisions = true;
    camera.minZ = 0.01; // Fix visibility for tiny characters
    scene.activeCamera = camera;
    scene.collisionsEnabled = true;
    scene.collisionRetryCount = 5; // More retries to prevent getting stuck in complex geometry

    // Pointer lock on click
    scene.onPointerDown = (evt) => {
        if (evt.button === 0) engine.enterPointerlock();
    };

    // Light
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // UI Manager
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    // Load map
    await loadMap(scene);

    // No invisible boundary walls are created

    // Preload character assets
    idleAssetContainer = await BABYLON.SceneLoader.LoadAssetContainerAsync("./", "stickman idle.glb", scene);
    runAssetContainer = await BABYLON.SceneLoader.LoadAssetContainerAsync("./", "stickman run.glb", scene);

    // Create UI
    createMenuUI();

    console.log("✅ Chase and Catch scene is ready!");
    return scene;
};

// Load the arena map and set up collision + boundary walls
async function loadMap(scene) {
    try {
        const result = await BABYLON.SceneLoader.ImportMeshAsync("", "./", "base.glb", scene);
        map = result.meshes[0];
        map.scaling = new BABYLON.Vector3(1500, 1500, 1500);
        map.position = new BABYLON.Vector3(50, 0, 0);

        mapMeshes = [];

        // First pass: apply transforms so bounding info is accurate
        result.meshes.forEach(mesh => {
            mesh.computeWorldMatrix(true);
        });

        // Second pass: enable collisions and fix materials
        result.meshes.forEach(mesh => {
            mesh.checkCollisions = true;
            mesh.isPickable = true; // Needed for raycasting
            if (mesh instanceof BABYLON.Mesh && mesh.getTotalVertices() > 0) {
                mesh.isVisible = true;
                mesh.refreshBoundingInfo();
                mesh.receiveShadows = true;
                mapMeshes.push(mesh);

                const ensureMaterial = (mat) => {
                    mat.alpha = 1;
                    mat.backFaceCulling = false;
                    mat.useAlphaFromDiffuseTexture = false;
                    mat.needDepthPrePass = true;
                    if (mat instanceof BABYLON.PBRMetallicRoughnessMaterial || mat instanceof BABYLON.PBRMaterial) {
                        mat.metallic = 0;
                        mat.roughness = 1;
                    }
                };

                if (mesh.material) {
                    ensureMaterial(mesh.material);
                } else {
                    const solidMat = new BABYLON.StandardMaterial("baseSolidMat", scene);
                    solidMat.diffuseColor = new BABYLON.Color3(0.85, 0.85, 0.85);
                    solidMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
                    solidMat.alpha = 1;
                    solidMat.backFaceCulling = false;
                    solidMat.needDepthPrePass = true;
                    mesh.material = solidMat;
                }
            }
        });

        // Compute arena bounding box from all map meshes
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
        result.meshes.forEach(mesh => {
            if (mesh instanceof BABYLON.Mesh && mesh.getTotalVertices() > 0) {
                const bi = mesh.getBoundingInfo();
                const wMin = bi.boundingBox.minimumWorld;
                const wMax = bi.boundingBox.maximumWorld;
                minX = Math.min(minX, wMin.x); maxX = Math.max(maxX, wMax.x);
                minZ = Math.min(minZ, wMin.z); maxZ = Math.max(maxZ, wMax.z);
                minY = Math.min(minY, wMin.y);
                maxY = Math.max(maxY, wMax.y);
            }
        });

        // Shrink bounds inward so characters spawn safely inside walls
        const inset = 30;
        arenaBounds = {
            minX: minX + inset, maxX: maxX - inset,
            minZ: minZ + inset, maxZ: maxZ - inset,
            groundY: minY + 2, // approx floor height
            topY: maxY // highest point
        };
        console.log("Arena bounds:", arenaBounds);

        // Freeze after all calculations
        result.meshes.forEach(mesh => {
            if (mesh instanceof BABYLON.Mesh && mesh.getTotalVertices() > 0) {
                mesh.freezeWorldMatrix();
            }
        });

        // Create invisible boundary walls to keep characters inside
        createBoundaryWalls(scene, arenaBounds);

    } catch (error) {
        console.error("Failed to load map:", error);
        console.warn("Game will continue without the base.glb arena");
        // Fallback flat ground
        arenaBounds = { minX: -150, maxX: 250, minZ: -200, maxZ: 200, groundY: -50, topY: -40 };
        createBoundaryWalls(scene, arenaBounds);
    }
}

// Create invisible solid walls around the arena perimeter
function createBoundaryWalls(scene, bounds) {
    const wallHeight = 80;
    const wallThickness = 5;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const halfW = (bounds.maxX - bounds.minX) / 2 + wallThickness;
    const halfD = (bounds.maxZ - bounds.minZ) / 2 + wallThickness;
    const groundY = bounds.groundY;

    const wallDefs = [
        // [x, y, z, scaleX, scaleY, scaleZ]
        [cx, groundY + wallHeight / 2, bounds.minZ - wallThickness / 2, halfW * 2 + wallThickness * 2, wallHeight, wallThickness], // North
        [cx, groundY + wallHeight / 2, bounds.maxZ + wallThickness / 2, halfW * 2 + wallThickness * 2, wallHeight, wallThickness], // South
        [bounds.minX - wallThickness / 2, groundY + wallHeight / 2, cz, wallThickness, wallHeight, halfD * 2], // West
        [bounds.maxX + wallThickness / 2, groundY + wallHeight / 2, cz, wallThickness, wallHeight, halfD * 2], // East
    ];

    wallDefs.forEach((w, i) => {
        const wall = BABYLON.MeshBuilder.CreateBox(`boundaryWall_${i}`, {
            width: w[3], height: w[4], depth: w[5]
        }, scene);
        wall.position = new BABYLON.Vector3(w[0], w[1], w[2]);
        wall.isVisible = false;
        wall.checkCollisions = true;
        wall.isPickable = false;
        wall.freezeWorldMatrix();
    });
    console.log("✅ Boundary walls created.");
}

// Helper to create a styled panel with glassmorphism look
function createStyledPanel(width = "520px", height = "auto") {
    const container = new BABYLON.GUI.Rectangle();
    container.width = width;
    container.height = height;
    container.background = UI_STYLES.colors.background;
    container.color = UI_STYLES.colors.border;
    container.thickness = 2;
    container.cornerRadius = UI_STYLES.cornerRadius;
    container.isPointerBlocker = true;

    // Subtle shadow/outer glow effect
    const shadow = new BABYLON.GUI.Rectangle();
    shadow.width = "102%";
    shadow.height = "102%";
    shadow.background = "rgba(0, 0, 0, 0.2)";
    shadow.thickness = 0;
    shadow.cornerRadius = UI_STYLES.cornerRadius + 2;
    shadow.zIndex = -1;

    return container;
}

// Create menu UI
function createMenuUI() {
    uiManager.dispose(); // Clear previous UI
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const overlay = new BABYLON.GUI.Rectangle();
    overlay.width = "100%";
    overlay.height = "100%";
    overlay.background = "rgba(0, 0, 0, 0.6)";
    overlay.thickness = 0;
    overlay.isPointerBlocker = true;
    uiManager.addControl(overlay);

    const panel = createStyledPanel("560px");
    panel.adaptHeightToChildren = true;
    panel.paddingTop = UI_STYLES.padding;
    panel.paddingBottom = UI_STYLES.padding;
    panel.paddingLeft = UI_STYLES.padding;
    panel.paddingRight = UI_STYLES.padding;
    uiManager.addControl(panel);

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "100%";
    panel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "CHASE & CATCH";
    title.color = UI_STYLES.colors.primary;
    title.fontSize = UI_STYLES.titleFontSize;
    title.fontFamily = UI_STYLES.fontFamily;
    title.fontWeight = "bold";
    title.height = "80px";
    title.paddingBottom = "10px";
    stack.addControl(title);

    const subtitle = new BABYLON.GUI.TextBlock();
    subtitle.text = "A High-Stakes Game of Speed and Strategy";
    subtitle.color = UI_STYLES.colors.secondary;
    subtitle.fontSize = UI_STYLES.subtitleFontSize;
    subtitle.fontFamily = UI_STYLES.fontFamily;
    subtitle.height = "40px";
    stack.addControl(subtitle);

    const description = new BABYLON.GUI.TextBlock();
    description.text = "Pick your team and prepare for the arena. Lock your opponents, unlock your allies, and survive the clock.";
    description.color = UI_STYLES.colors.secondary;
    description.fontSize = UI_STYLES.bodyFontSize;
    description.fontFamily = UI_STYLES.fontFamily;
    description.textWrapping = true;
    description.height = "100px";
    description.paddingTop = "10px";
    description.paddingBottom = "30px";
    stack.addControl(description);

    const buttonRow = new BABYLON.GUI.StackPanel();
    buttonRow.isVertical = false;
    buttonRow.height = "90px";
    buttonRow.spacing = 20;
    stack.addControl(buttonRow);

    const createTeamButton = (text, color, callback) => {
        const btn = BABYLON.GUI.Button.CreateSimpleButton("btn", text);
        btn.width = "220px";
        btn.height = "70px";
        btn.color = "white";
        btn.background = color;
        btn.cornerRadius = 15;
        btn.thickness = 0;
        btn.fontSize = 24;
        btn.fontFamily = UI_STYLES.fontFamily;
        btn.fontWeight = "bold";
        btn.onPointerUpObservable.add(callback);

        // Hover effect
        btn.onPointerEnterObservable.add(() => {
            btn.alpha = 0.9;
            btn.scaleX = 1.02;
            btn.scaleY = 1.02;
        });
        btn.onPointerOutObservable.add(() => {
            btn.alpha = 1.0;
            btn.scaleX = 1.0;
            btn.scaleY = 1.0;
        });

        return btn;
    };

    const redButton = createTeamButton("RED TEAM", UI_STYLES.colors.buttonRed, () => {
        playerTeam = TEAM_RED;
        startCoinToss();
    });
    buttonRow.addControl(redButton);

    const blueButton = createTeamButton("BLUE TEAM", UI_STYLES.colors.buttonBlue, () => {
        playerTeam = TEAM_BLUE;
        startCoinToss();
    });
    buttonRow.addControl(blueButton);
}

// Start coin toss with heads/tails choice
function startCoinToss() {
    gameState = 'coinToss';
    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const overlay = new BABYLON.GUI.Rectangle();
    overlay.width = "100%";
    overlay.height = "100%";
    overlay.background = "rgba(3, 13, 35, 0.72)";
    overlay.thickness = 0;
    overlay.isPointerBlocker = true;
    uiManager.addControl(overlay);

    const panel = createStyledPanel("560px");
    panel.adaptHeightToChildren = true;
    panel.paddingTop = UI_STYLES.padding;
    panel.paddingBottom = UI_STYLES.padding;
    panel.paddingLeft = UI_STYLES.padding;
    panel.paddingRight = UI_STYLES.padding;
    uiManager.addControl(panel);

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "100%";
    panel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "THE TOSS";
    title.color = UI_STYLES.colors.accent;
    title.fontSize = 44;
    title.fontFamily = UI_STYLES.fontFamily;
    title.fontWeight = "bold";
    title.height = "60px";
    title.paddingBottom = "10px";
    stack.addControl(title);

    const info = new BABYLON.GUI.TextBlock();
    info.text = `Team ${playerTeam.toUpperCase()} chosen. Pick Heads or Tails to decide who starts.`;
    info.color = UI_STYLES.colors.secondary;
    info.fontSize = UI_STYLES.subtitleFontSize;
    info.fontFamily = UI_STYLES.fontFamily;
    info.textWrapping = true;
    info.height = "80px";
    info.paddingBottom = "20px";
    stack.addControl(info);

    const buttonRow = new BABYLON.GUI.StackPanel();
    buttonRow.isVertical = false;
    buttonRow.height = "90px";
    buttonRow.spacing = 20;
    stack.addControl(buttonRow);

    const createTossButton = (text, color, callback) => {
        const btn = BABYLON.GUI.Button.CreateSimpleButton("btn", text);
        btn.width = "210px";
        btn.height = "70px";
        btn.color = "#08111f";
        btn.background = color;
        btn.cornerRadius = 15;
        btn.thickness = 0;
        btn.fontSize = 24;
        btn.fontFamily = UI_STYLES.fontFamily;
        btn.fontWeight = "bold";
        btn.onPointerUpObservable.add(callback);
        return btn;
    };

    const headsButton = createTossButton("HEADS", "#ffd24d", () => performCoinFlip("heads"));
    buttonRow.addControl(headsButton);

    const tailsButton = createTossButton("TAILS", "#8aa1c4", () => performCoinFlip("tails"));
    buttonRow.addControl(tailsButton);
}

// Perform the coin flip animation
function performCoinFlip(playerChoice) {
    gameState = 'coinFlip';
    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const panel = createStyledPanel("400px", "200px");
    uiManager.addControl(panel);

    const flipText = new BABYLON.GUI.TextBlock();
    flipText.text = "🪙 FLIPPING...";
    flipText.color = UI_STYLES.colors.accent;
    flipText.fontSize = 40;
    flipText.fontFamily = UI_STYLES.fontFamily;
    flipText.fontWeight = "bold";
    panel.addControl(flipText);

    // Animate coin flip
    let flipCount = 0;
    const flipInterval = setInterval(() => {
        flipCount++;
        flipText.text = flipCount % 2 === 0 ? "🪙 HEADS" : "🪙 TAILS";
    }, 150);

    setTimeout(() => {
        clearInterval(flipInterval);
        const result = Math.random() < 0.5 ? "heads" : "tails";
        flipText.text = result === "heads" ? "🪙 HEADS" : "🪙 TAILS";

        const playerWon = result === playerChoice;

        setTimeout(() => {
            if (playerWon) {
                flipText.text = "YOU WON!";
                flipText.color = "#4dff88";
                setTimeout(() => assignRoles(playerTeam), 1500);
            } else {
                flipText.text = "YOU LOST!";
                flipText.color = "#ff4d4d";
                setTimeout(() => {
                    const aiChoosesChase = Math.random() < 0.5;
                    if (aiChoosesChase) {
                        chaseTeam = playerTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED;
                        runTeam = playerTeam;
                    } else {
                        runTeam = playerTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED;
                        chaseTeam = playerTeam;
                    }
                    startGame();
                }, 1500);
            }
        }, 1500);
    }, 2500);
}

// Assign roles based on coin toss winner
function assignRoles(tossWinner) {
    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const overlay = new BABYLON.GUI.Rectangle();
    overlay.width = "100%";
    overlay.height = "100%";
    overlay.background = "rgba(6, 16, 34, 0.75)";
    overlay.thickness = 0;
    overlay.isPointerBlocker = true;
    uiManager.addControl(overlay);

    const panel = createStyledPanel("560px");
    panel.adaptHeightToChildren = true;
    panel.paddingTop = UI_STYLES.padding;
    panel.paddingBottom = UI_STYLES.padding;
    panel.paddingLeft = UI_STYLES.padding;
    panel.paddingRight = UI_STYLES.padding;
    uiManager.addControl(panel);

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = "100%";
    panel.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "CHOOSE YOUR ROLE";
    title.color = UI_STYLES.colors.primary;
    title.fontSize = 40;
    title.fontFamily = UI_STYLES.fontFamily;
    title.fontWeight = "bold";
    title.height = "60px";
    title.paddingBottom = "10px";
    stack.addControl(title);

    const info = new BABYLON.GUI.TextBlock();
    info.text = `${tossWinner.toUpperCase()} Team won the toss. Will you Chase or Run?`;
    info.color = UI_STYLES.colors.secondary;
    info.fontSize = UI_STYLES.subtitleFontSize;
    info.fontFamily = UI_STYLES.fontFamily;
    info.textWrapping = true;
    info.height = "60px";
    info.paddingBottom = "20px";
    stack.addControl(info);

    const buttonRow = new BABYLON.GUI.StackPanel();
    buttonRow.isVertical = false;
    buttonRow.height = "90px";
    buttonRow.spacing = 20;
    stack.addControl(buttonRow);

    const createRoleButton = (text, color, callback) => {
        const btn = BABYLON.GUI.Button.CreateSimpleButton("btn", text);
        btn.width = "210px";
        btn.height = "70px";
        btn.color = "white";
        btn.background = color;
        btn.cornerRadius = 15;
        btn.thickness = 0;
        btn.fontSize = 24;
        btn.fontFamily = UI_STYLES.fontFamily;
        btn.fontWeight = "bold";
        btn.onPointerUpObservable.add(callback);
        return btn;
    };

    const chaseButton = createRoleButton("CHASE", UI_STYLES.colors.buttonRed, () => {
        chaseTeam = tossWinner;
        runTeam = tossWinner === TEAM_RED ? TEAM_BLUE : TEAM_RED;
        startGame();
    });
    buttonRow.addControl(chaseButton);

    const runButton = createRoleButton("RUN", UI_STYLES.colors.buttonBlue, () => {
        runTeam = tossWinner;
        chaseTeam = tossWinner === TEAM_RED ? TEAM_BLUE : TEAM_RED;
        startGame();
    });
    buttonRow.addControl(runButton);
}

// Start the game
async function startGame() {
    gameState = 'game';
    gameUICreated = false; // Reset UI flag
    timerTextUI = null;
    roleTextUI = null;
    statusTextUI = null;

    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    // Create characters
    await createCharacters();

    // Setup camera to follow player (AAA-style 3rd person)
    const camera = scene.activeCamera;
    camera.setTarget(player.mesh);

    // Setup controls
    setupControls();

    // Start timer
    startTime = Date.now();

    // Game loop
    scene.onBeforeRenderObservable.add(() => {
        updateGame();
    });
}

// Helper to spawn GLB characters
async function spawnGLBCharacter(team, isPlayer) {
    const container = new BABYLON.Mesh(`characterRoot_${team}_${isPlayer ? 'player' : 'ai'}_${Date.now()}`, scene);
    container.isVisible = false;
    container.checkCollisions = true;
    // Wider ellipsoid to prevent getting stuck in tight crevices/props
    container.ellipsoid = new BABYLON.Vector3(0.4, 1.2, 0.4);
    container.ellipsoidOffset = new BABYLON.Vector3(0, 1.2, 0);

    // Use AssetContainers to avoid reloading the GLB for every character (HUGE FPS FIX)
    const idleInstance = idleAssetContainer.instantiateModelsToScene(name => `${name}_idle_${Date.now()}`);
    const runInstance = runAssetContainer.instantiateModelsToScene(name => `${name}_run_${Date.now()}`);

    // Parent ALL root nodes to a wrapper to ensure they scale and move together
    const idleRoot = new BABYLON.TransformNode("idleRoot_" + Date.now(), scene);
    idleRoot.parent = container;
    idleInstance.rootNodes.forEach(node => node.parent = idleRoot);

    const runRoot = new BABYLON.TransformNode("runRoot_" + Date.now(), scene);
    runRoot.parent = container;
    runInstance.rootNodes.forEach(node => node.parent = runRoot);
    runRoot.setEnabled(false);

    const setupMeshes = (instance) => {
        instance.rootNodes.forEach(root => {
            root.getChildMeshes().forEach(mesh => {
                const name = mesh.name.toLowerCase();
                if (mesh instanceof BABYLON.LinesMesh || name.includes('line') || name.includes('ray') || name.includes('bone') || name.includes('armature') || (mesh.getTotalVertices && mesh.getTotalVertices() < 50)) {
                    mesh.isVisible = false;
                    return;
                }
                if (mesh.material) {
                    const newMat = mesh.material.clone(mesh.material.name + "_" + team + "_" + Date.now());
                    const teamColor = team === TEAM_RED ? BABYLON.Color3.Red() : BABYLON.Color3.Blue();
                    if (newMat instanceof BABYLON.PBRMaterial) {
                        newMat.albedoColor = teamColor;
                    } else {
                        newMat.diffuseColor = teamColor;
                    }
                    mesh.material = newMat;
                }
            });
        });
    };

    setupMeshes(idleInstance);
    setupMeshes(runInstance);

    container.scaling = new BABYLON.Vector3(0.12, 0.12, 0.12); // Larger players for the massive arena

    // Calculate vertical offset for ground alignment
    let minY = Infinity;
    idleInstance.rootNodes.forEach(root => {
        root.getChildMeshes().forEach(mesh => {
            if (mesh.getBoundingInfo) {
                const bounds = mesh.getBoundingInfo().boundingBox;
                minY = Math.min(minY, bounds.minimum.y);
            }
        });
    });

    // Position character above the arena floor (we'll let gravity + raycast settle them)
    const yPos = arenaBounds.topY + 15;
    container.position = new BABYLON.Vector3(0, yPos, 0);

    const idleAnim = idleInstance.animationGroups[0];
    const runAnim = runInstance.animationGroups[0];
    if (idleAnim) idleAnim.stop();
    if (runAnim) runAnim.stop();

    // Individual AI properties (Unique Knowledge)
    const intelligence = 0.5 + Math.random() * 0.5;
    const detectionRange = 40 + Math.random() * 40;
    const individualSpeed = (team === runTeam ? 0.48 : 0.44) * (0.95 + Math.random() * 0.1);

    return {
        mesh: container,
        idleRoot: idleRoot,
        runRoot: runRoot,
        team: team,
        isLocked: false,
        isPlayer: isPlayer,
        isAI: !isPlayer,
        speed: individualSpeed,
        intelligence: intelligence,
        detectionRange: detectionRange,
        personalityOffset: Math.random() * 100, // Random seed for jitter
        isRunning: false,
        isStretching: false,
        animationGroups: [...(idleInstance.animationGroups || []), ...(runInstance.animationGroups || [])],
        idleAnim: idleAnim,
        runAnim: runAnim,
        currentAnim: null,
        yVelocity: 0,
        jumpCooldown: 0,
        isGrounded: true
    };
}

// Create all characters
async function createCharacters() {
    characters = [];

    const oppTeam = playerTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED;
    const baseCenter = map ? map.position.clone() : new BABYLON.Vector3(0, 0, 0);

    player = await spawnGLBCharacter(playerTeam, true);
    characters.push(player);

    for (let i = 0; i < 5; i++) {
        const ai = await spawnGLBCharacter(playerTeam, false);
        characters.push(ai);
    }

    for (let i = 0; i < 6; i++) {
        const ai = await spawnGLBCharacter(oppTeam, false);
        characters.push(ai);
    }

    // Spawn characters inside the arena bounds, above ground so they fall onto the surface
    const arenaW = arenaBounds.maxX - arenaBounds.minX;
    const arenaD = arenaBounds.maxZ - arenaBounds.minZ;
    const centerX = (arenaBounds.minX + arenaBounds.maxX) / 2;
    const centerZ = (arenaBounds.minZ + arenaBounds.maxZ) / 2;
    const teamOffset = arenaW * 0.18; // Spread teams on opposite sides
    const spawnY = arenaBounds.topY + 15; // Spawn at top of the base, higher above the highest point

    characters.forEach((char) => {
        const side = char.team === playerTeam ? -teamOffset : teamOffset;
        // Keep well within arena bounds
        const safeMargin = 40;
        const halfW = arenaW / 2 - safeMargin;
        const halfD = arenaD / 2 - safeMargin;
        const x = centerX + side + (Math.random() - 0.5) * Math.min(halfW, 60);
        const z = centerZ + (Math.random() - 0.5) * Math.min(halfD * 2, 100);
        char.mesh.position = new BABYLON.Vector3(x, spawnY, z);
        char.mesh.checkCollisions = true;
        char.isGrounded = true;
        char.yVelocity = 0;
    });
}


// Raycast downward to find the actual surface Y under a character
function getGroundY(position) {
    // For gameplay, use the top of the base as the "ground" to keep players at the top height
    return arenaBounds.topY;
}

function applyGravity(char) {
    const groundY = getGroundY(char.mesh.position);

    if (gameState === 'game' && startTime && (Date.now() - startTime) / 1000 < START_DELAY) {
        char.yVelocity = 0;
        char.mesh.position.y = arenaBounds.topY + 15;
        char.isGrounded = true;
        return;
    }

    // Keep all characters at the top surface level, no dropping or jumping
    char.yVelocity = 0;
    char.mesh.position.y = groundY + 15;
    char.isGrounded = true;
}

// Setup player controls
function setupControls() {
    const keys = {};
    window.addEventListener('keydown', (e) => {
        keys[e.code] = true;
        if (e.key === 'Shift') keys['Shift'] = true;
    });
    window.addEventListener('keyup', (e) => {
        keys[e.code] = false;
        if (e.key === 'Shift') keys['Shift'] = false;
    });

    scene.onBeforeRenderObservable.add(() => {
        if (gameState !== 'game' || !player) return;

        const elapsed = (Date.now() - startTime) / 1000;

        if (player.team === chaseTeam) {
            player.isStretching = keys['Shift'] || keys['ShiftLeft'] || keys['ShiftRight'];
            // Prevent movement for first 3 seconds
            if (elapsed < 3) return;
        }

        if (player.isLocked) {
            player.isRunning = false;
            return;
        }

        const camera = scene.activeCamera;
        let inputVector = BABYLON.Vector3.Zero();

        // Get camera direction vectors
        const forward = BABYLON.Vector3.Normalize(camera.target.subtract(camera.position));
        forward.y = 0; forward.normalize();
        const right = BABYLON.Vector3.Cross(forward, BABYLON.Vector3.Up());

        // WASD movement relative to camera
        if (keys['KeyW'] || keys['ArrowUp']) inputVector.addInPlace(forward);
        if (keys['KeyS'] || keys['ArrowDown']) inputVector.subtractInPlace(forward);
        if (keys['KeyD'] || keys['ArrowRight']) inputVector.subtractInPlace(right);
        if (keys['KeyA'] || keys['ArrowLeft']) inputVector.addInPlace(right);

        applyGravity(player);

        if ((keys['Space'] || keys['ShiftLeft'] || keys['ShiftRight']) && player.team === runTeam && player.isGrounded && player.jumpCooldown <= 0) {
            player.yVelocity = JUMP_FORCE;
            player.jumpCooldown = 120; // 2 sec cooldown
        }

        let moveVector = BABYLON.Vector3.Zero();
        if (inputVector.length() > 0) {
            inputVector.normalize();
            inputVector.scaleInPlace(player.speed); // Use character speed
            moveVector.x = inputVector.x;
            moveVector.z = inputVector.z;
        }
        moveVector.y = player.yVelocity;

        if (moveVector.x !== 0 || moveVector.z !== 0 || moveVector.y !== 0) {
            player.mesh.moveWithCollisions(moveVector);

            if (inputVector.length() > 0) {
                const angle = Math.atan2(moveVector.x, moveVector.z);
                player.mesh.rotation.y = angle;
                player.isRunning = true;
            } else if (!player.isGrounded) {
                player.isRunning = true;
            } else {
                player.isRunning = false;
            }
        } else {
            player.isRunning = false;
        }
    });
}

// Update game logic
function updateGame() {
    if (gameState !== 'game') return;

    const deltaTime = engine.getDeltaTime() / 1000;

    // Update timer
    const elapsed = (Date.now() - startTime) / 1000;
    timer = Math.max(0, 360 - elapsed);

    // Update UI
    updateGameUI();

    // AI behavior
    updateAI();

    // Check tagging
    checkTagging();

    // Check win/lose conditions
    checkWinLose();

    // Update animations for all characters
    updateAnimations();
}

// Global animation updater
function updateAnimations() {
    characters.forEach(char => {
        if (char.isLocked) {
            if (char.currentAnim !== 'idle') {
                if (char.runAnim) char.runAnim.stop();
                if (char.idleAnim) char.idleAnim.start(true);
                if (char.runRoot) char.runRoot.setEnabled(false);
                if (char.idleRoot) char.idleRoot.setEnabled(true);
                char.currentAnim = 'idle';
            }
            return;
        }

        if (char.isRunning) {
            if (char.currentAnim !== 'run') {
                if (char.idleAnim) char.idleAnim.stop();
                if (char.runAnim) char.runAnim.start(true);
                if (char.idleRoot) char.idleRoot.setEnabled(false);
                if (char.runRoot) char.runRoot.setEnabled(true);
                char.currentAnim = 'run';
            }
        } else {
            if (char.currentAnim !== 'idle') {
                if (char.runAnim) char.runAnim.stop();
                if (char.idleAnim) char.idleAnim.start(true);
                if (char.runRoot) char.runRoot.setEnabled(false);
                if (char.idleRoot) char.idleRoot.setEnabled(true);
                char.currentAnim = 'idle';
            }
        }
    });
}

// Global UI elements

// Create game UI (only once)
function createGameUI() {
    if (gameUICreated) return;
    gameUICreated = true;

    const hudRoot = new BABYLON.GUI.Rectangle();
    hudRoot.width = "300px";
    hudRoot.height = "220px";
    hudRoot.thickness = 2;
    hudRoot.color = "rgba(255, 255, 255, 0.1)";
    hudRoot.background = "rgba(0, 0, 0, 0.4)";
    hudRoot.cornerRadius = 15;
    hudRoot.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    hudRoot.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    hudRoot.left = "20px";
    hudRoot.top = "20px";
    hudRoot.paddingLeft = "15px";
    hudRoot.paddingRight = "15px";
    hudRoot.paddingTop = "10px";
    hudRoot.paddingBottom = "10px";
    uiManager.addControl(hudRoot);

    const hudContainer = new BABYLON.GUI.StackPanel();
    hudContainer.width = "100%";
    hudContainer.isVertical = true;
    hudContainer.spacing = 2;
    hudRoot.addControl(hudContainer);

    const createHUDText = (text, size, color, isBold = false) => {
        const tb = new BABYLON.GUI.TextBlock();
        tb.text = text;
        tb.color = color;
        tb.fontSize = size;
        tb.fontFamily = UI_STYLES.fontFamily;
        tb.fontWeight = isBold ? "bold" : "normal";
        tb.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        tb.height = "32px";
        return tb;
    };

    timerTextUI = createHUDText("TIME: 06:00", 28, UI_STYLES.colors.accent, true);
    hudContainer.addControl(timerTextUI);

    roleTextUI = createHUDText("ROLE: ...", 22, "white", true);
    hudContainer.addControl(roleTextUI);

    teamTextUI = createHUDText("TEAM: ...", 20, "white");
    hudContainer.addControl(teamTextUI);

    playersTextUI = createHUDText("PLAYERS: 6/6", 18, "white");
    hudContainer.addControl(playersTextUI);

    lockedTextUI = createHUDText("LOCKED: 0/6", 18, "white");
    hudContainer.addControl(lockedTextUI);

    statusTextUI = createHUDText("STATUS: Starting...", 16, UI_STYLES.colors.secondary);
    hudContainer.addControl(statusTextUI);
}

// Update game UI
function updateGameUI() {
    if (!gameUICreated) {
        createGameUI();
    }

    if (timerTextUI) {
        const mins = Math.floor(timer / 60);
        const secs = Math.floor(timer % 60);
        timerTextUI.text = `TIME: ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    if (roleTextUI) {
        const isChaser = playerTeam === chaseTeam;
        roleTextUI.text = `ROLE: ${isChaser ? 'CHASER' : 'RUNNER'}`;
        roleTextUI.color = isChaser ? UI_STYLES.colors.red : UI_STYLES.colors.blue;
    }

    if (teamTextUI) {
        teamTextUI.text = `TEAM: ${playerTeam.toUpperCase()}`;
        teamTextUI.color = playerTeam === TEAM_RED ? UI_STYLES.colors.red : UI_STYLES.colors.blue;
    }

    if (playersTextUI) {
        const aliveCount = characters.filter(char => char.team === playerTeam && !char.isLocked).length;
        playersTextUI.text = `ACTIVE ALLIES: ${aliveCount}/6`;
    }

    if (lockedTextUI) {
        const lockedOpponents = characters.filter(char => char.team === runTeam && char.isLocked).length;
        lockedTextUI.text = `LOCKED ENEMIES: ${lockedOpponents}/6`;
    }

    if (statusTextUI) {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed < 3) {
            statusTextUI.text = `CATCHERS READY IN: ${Math.ceil(3 - elapsed)}s`;
            statusTextUI.color = UI_STYLES.colors.accent;
        } else {
            statusTextUI.text = "STATUS: ROUND ACTIVE";
            statusTextUI.color = "#4dff88";
        }
    }
}
// Update AI behavior
function updateAI() {
    const elapsed = (Date.now() - startTime) / 1000;

    characters.forEach((char, index) => {
        // Skip player and skip locked characters completely (they freeze)
        if (char.isPlayer) return;
        if (char.isLocked) {
            char.isRunning = false;
            char.yVelocity = 0; // Prevent gravity jitter
            return;
        }

        // PERFORMANCE: Update AI decision logic less frequently (distributed across frames)
        const frameOffset = (Math.floor(Date.now() / 16) + index) % 3;
        const shouldRethink = frameOffset === 0;

        applyGravity(char);

        let direction = char.lastDirection || BABYLON.Vector3.Zero();

        if (shouldRethink) {
            let targetInfo = null;
            let newDir = BABYLON.Vector3.Zero();

            if (char.team === chaseTeam) {
                // Chase AI: find best opponent
                if (elapsed < 3) return; // Catchers freeze for first 3 seconds

                const target = findNearestUnlockedOpponent(char);
                if (target) {
                    targetInfo = { target: target, action: 'chase' };
                    const dist = BABYLON.Vector3.Distance(char.mesh.position, target.mesh.position);
                    char.isStretching = dist < 5;

                    // Base direction
                    newDir = target.mesh.position.subtract(char.mesh.position).normalize();

                    // INDIVIDUAL KNOWLEDGE: Add personal jitter/offset based on intelligence
                    const jitter = new BABYLON.Vector3(
                        Math.sin(Date.now() / 1000 + char.personalityOffset),
                        0,
                        Math.cos(Date.now() / 1000 + char.personalityOffset)
                    ).scale(1.0 - char.intelligence);
                    newDir.addInPlace(jitter);

                    // SPREAD OUT: Repulsion from TEAMMATES ONLY to avoid grouping
                    characters.forEach(other => {
                        if (other !== char && other.team === char.team && !other.isLocked) {
                            const d = BABYLON.Vector3.Distance(char.mesh.position, other.mesh.position);
                            if (d < 25) {
                                const rep = char.mesh.position.subtract(other.mesh.position).normalize();
                                const strength = (25 - d) / 25;
                                newDir.addInPlace(rep.scale(strength * 1.2));
                            }
                        }
                    });
                }
            } else {
                // Run AI
                targetInfo = findPriorityTarget(char);

                if (targetInfo && targetInfo.target) {
                    const targetPos = targetInfo.target.mesh.position;
                    if (targetInfo.action === 'flee') {
                        newDir = char.mesh.position.subtract(targetPos).normalize();
                        // INDIVIDUAL WEAVING: unique per character
                        const sideDir = BABYLON.Vector3.Cross(newDir, BABYLON.Vector3.Up()).normalize();
                        newDir.addInPlace(sideDir.scale(Math.sin(Date.now() / (400 + char.personalityOffset) + char.mesh.uniqueId) * 0.7));
                    } else {
                        newDir = targetPos.subtract(char.mesh.position).normalize();
                    }
                }

                // SPREAD OUT: Run team separation (teammates only)
                characters.forEach(other => {
                    if (other !== char && other.team === char.team && !other.isLocked) {
                        const d = BABYLON.Vector3.Distance(char.mesh.position, other.mesh.position);
                        if (d < 30) {
                            const rep = char.mesh.position.subtract(other.mesh.position).normalize();
                            const strength = (30 - d) / 30;
                            newDir.addInPlace(rep.scale(strength * 1.8));
                        }
                    }
                });

                // Auto-jump logic
                if (char.isGrounded && char.jumpCooldown <= 0) {
                    const nearest = findNearestChaser(char);
                    if (nearest && BABYLON.Vector3.Distance(char.mesh.position, nearest.mesh.position) < 15) {
                        char.yVelocity = JUMP_FORCE;
                        char.jumpCooldown = 60;
                    }
                }
            }

            if (newDir.length() > 0) {
                newDir.normalize();
                char.lastDirection = newDir;
                direction = newDir;
            }
        }

        if (direction.length() > 0.01) {
            direction.y = 0;

            // SMART ARENA BOUNDARY AVOIDANCE: push back inside the real arena walls
            const buffer = 25; // Start turning away this many units before the wall
            let pushBack = new BABYLON.Vector3(0, 0, 0);

            if (char.mesh.position.x < arenaBounds.minX + buffer) pushBack.x = 1;
            else if (char.mesh.position.x > arenaBounds.maxX - buffer) pushBack.x = -1;

            if (char.mesh.position.z < arenaBounds.minZ + buffer) pushBack.z = 1;
            else if (char.mesh.position.z > arenaBounds.maxZ - buffer) pushBack.z = -1;

            if (pushBack.length() > 0) {
                direction.addInPlace(pushBack.scale(3.0));
            }

            // Hard clamp: if already outside bounds, teleport back to center edge
            if (char.mesh.position.x < arenaBounds.minX || char.mesh.position.x > arenaBounds.maxX ||
                char.mesh.position.z < arenaBounds.minZ || char.mesh.position.z > arenaBounds.maxZ) {
                const cx = (arenaBounds.minX + arenaBounds.maxX) / 2;
                const cz = (arenaBounds.minZ + arenaBounds.maxZ) / 2;
                char.mesh.position.x = cx + (Math.random() - 0.5) * 20;
                char.mesh.position.z = cz + (Math.random() - 0.5) * 20;
                char.yVelocity = 0;
                char.lastDirection = null;
            }

            direction.normalize();
            direction.scaleInPlace(char.speed);
        }

        let moveVector = new BABYLON.Vector3(direction.x, char.yVelocity, direction.z);

        if (moveVector.length() > 0.001) {
            const oldPos = char.mesh.position.clone();
            char.mesh.moveWithCollisions(moveVector);

            const actualMove = BABYLON.Vector3.Distance(oldPos, char.mesh.position);
            if (actualMove > 0.005) {
                char.mesh.rotation.y = Math.atan2(direction.x, direction.z);
                char.isRunning = true;
            } else {
                // If stuck, try to jitter away
                if (shouldRethink) {
                    char.lastDirection = new BABYLON.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                }
                char.isRunning = false;
            }
        } else {
            char.isRunning = false;
        }
    });
}

// Find priority target for runners: flee chasers first, then rescue, then wander away
function findPriorityTarget(runner) {
    const nearestChaser = findNearestChaser(runner);

    // Priority 1: If a chaser is within individual detection range, FLEE
    if (nearestChaser) {
        const distToChaser = BABYLON.Vector3.Distance(runner.mesh.position, nearestChaser.mesh.position);
        if (distToChaser < runner.detectionRange) { // Use individual detection range
            return { target: nearestChaser, action: 'flee' };
        }
    }

    // Priority 2: Find nearest locked teammate to unlock
    let lockedTeammate = null;
    let minDist = Infinity;
    characters.forEach(char => {
        if (char.team === runTeam && char.isLocked) {
            const dist = BABYLON.Vector3.Distance(runner.mesh.position, char.mesh.position);
            if (dist < minDist) {
                minDist = dist;
                lockedTeammate = char;
            }
        }
    });

    if (lockedTeammate) {
        return { target: lockedTeammate, action: 'rescue' };
    }

    // Priority 3: No one to rescue, stay away from nearest chaser
    if (nearestChaser) {
        return { target: nearestChaser, action: 'flee' };
    }

    return null;
}

// Find best unlocked opponent for chasers (diversifies targets)
function findNearestUnlockedOpponent(chaser) {
    let nearest = null;
    let minScore = Infinity;

    characters.forEach(char => {
        if (char.team !== chaser.team && !char.isLocked) {
            const dist = BABYLON.Vector3.Distance(chaser.mesh.position, char.mesh.position);

            // INTELLIGENCE: dogpile avoidance
            // Calculate how many OTHER chasers are already close to this runner
            let dogpilePenalty = 0;
            characters.forEach(other => {
                if (other !== chaser && other.team === chaser.team) {
                    const distToTarget = BABYLON.Vector3.Distance(other.mesh.position, char.mesh.position);
                    if (distToTarget < 40) { // If teammate is already close to this guy
                        dogpilePenalty += 80; // Make this target less attractive
                    }
                }
            });

            const score = dist + dogpilePenalty;
            if (score < minScore) {
                minScore = score;
                nearest = char;
            }
        }
    });
    return nearest;
}

// Find nearest chaser
function findNearestChaser(runner) {
    let nearest = null;
    let minDist = Infinity;
    characters.forEach(char => {
        if (char.team === chaseTeam) {
            const dist = BABYLON.Vector3.Distance(runner.mesh.position, char.mesh.position);
            if (dist < minDist) {
                minDist = dist;
                nearest = char;
            }
        }
    });
    return nearest;
}

// Check tagging mechanics - Lock and Key system
function checkTagging() {
    characters.forEach(chaser => {
        // Chasers can lock runners
        if (chaser.team !== chaseTeam || chaser.isLocked) return;
        if (!chaser.isStretching) return; // Must stretch hand to catch

        const rootPos = chaser.mesh.getAbsolutePosition ? chaser.mesh.getAbsolutePosition() : chaser.mesh.position.clone();
        const forward = new BABYLON.Vector3(Math.sin(chaser.mesh.rotation.y), 0, Math.cos(chaser.mesh.rotation.y));
        const handPos = rootPos.add(new BABYLON.Vector3(0, 1.5, 0)).add(forward.scale(2.0));

        characters.forEach(runner => {
            // Check if this is an unlocked opponent
            if (runner.team === runTeam && !runner.isLocked) {
                // RULE: Cannot lock a player who is currently in the air (jumping)
                if (!runner.isGrounded) return;

                const dist = BABYLON.Vector3.Distance(handPos, runner.mesh.position);
                // Tagging distance - if chaser touches runner with stretched hand
                if (dist < 2.0) {
                    lockRunner(runner, chaser);
                }
            }
        });
    });

    // Runners can unlock their locked teammates
    characters.forEach(teammate => {
        if (teammate.team === runTeam && !teammate.isLocked) {
            characters.forEach(locked => {
                // Check if this is a locked teammate
                if (locked.team === runTeam && locked.isLocked) {
                    const dist = BABYLON.Vector3.Distance(teammate.mesh.position, locked.mesh.position);
                    // Unlocking distance - if teammate touches locked player, they unlock
                    if (dist < 2.5) {
                        unlockRunner(locked);
                    }
                }
            });
        }
    });
}

// Lock a runner (turns gray until a teammate touches them)
function lockRunner(runner, chaser) {
    runner.isLocked = true;
    // Change all child meshes to gray
    runner.mesh.getChildMeshes().forEach(child => {
        if (child.material) {
            const gray = new BABYLON.Color3(0.5, 0.5, 0.5);
            if (child.material instanceof BABYLON.PBRMaterial) {
                child.material.albedoColor = gray;
            } else {
                child.material.diffuseColor = gray;
            }
        }
    });
    console.log(`${runner.team} runner locked!`);
}

// Unlock a runner (teammate touches them to restore)
function unlockRunner(runner) {
    runner.isLocked = false;
    const color = runner.team === TEAM_RED ? BABYLON.Color3.Red() : BABYLON.Color3.Blue();
    runner.mesh.getChildMeshes().forEach(child => {
        if (child.material) {
            if (child.material instanceof BABYLON.PBRMaterial) {
                child.material.albedoColor = color;
            } else {
                child.material.diffuseColor = color;
            }
        }
    });
    console.log(`${runner.team} runner unlocked by teammate!`);
}

// Check win/lose conditions
function checkWinLose() {
    const lockedOpponents = characters.filter(char => char.team === runTeam && char.isLocked).length;
    const totalOpponents = characters.filter(char => char.team === runTeam).length;

    if (playerTeam === chaseTeam && lockedOpponents === totalOpponents) {
        showWinScreen();
    } else if (playerTeam === runTeam && timer <= 0) {
        showWinScreen();
    } else if (playerTeam === chaseTeam && timer <= 0) {
        showLoseScreen();
    } else if (playerTeam === runTeam && lockedOpponents === totalOpponents) {
        showLoseScreen();
    }
}

// Show win screen
function showWinScreen() {
    gameState = 'win';
    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const overlay = new BABYLON.GUI.Rectangle();
    overlay.width = "100%";
    overlay.height = "100%";
    overlay.background = "rgba(10, 40, 20, 0.8)";
    overlay.thickness = 0;
    uiManager.addControl(overlay);

    const panel = createStyledPanel("500px", "300px");
    uiManager.addControl(panel);

    const stack = new BABYLON.GUI.StackPanel();
    panel.addControl(stack);

    const winText = new BABYLON.GUI.TextBlock();
    winText.text = "VICTORY";
    winText.color = "#4dff88";
    winText.fontSize = 72;
    winText.fontFamily = UI_STYLES.fontFamily;
    winText.fontWeight = "bold";
    winText.height = "100px";
    stack.addControl(winText);

    const subText = new BABYLON.GUI.TextBlock();
    subText.text = "You have dominated the arena.";
    subText.color = UI_STYLES.colors.secondary;
    subText.fontSize = 20;
    subText.fontFamily = UI_STYLES.fontFamily;
    subText.height = "40px";
    stack.addControl(subText);

    const restartButton = BABYLON.GUI.Button.CreateSimpleButton("restartButton", "REPLAY");
    restartButton.width = "200px";
    restartButton.height = "60px";
    restartButton.color = "white";
    restartButton.background = "#2d6a4f";
    restartButton.cornerRadius = 15;
    restartButton.thickness = 0;
    restartButton.fontSize = 24;
    restartButton.fontFamily = UI_STYLES.fontFamily;
    restartButton.fontWeight = "bold";
    restartButton.top = "20px";
    restartButton.onPointerUpObservable.add(() => {
        location.reload();
    });
    stack.addControl(restartButton);
}

// Show lose screen
function showLoseScreen() {
    gameState = 'lose';
    uiManager.dispose();
    uiManager = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

    const overlay = new BABYLON.GUI.Rectangle();
    overlay.width = "100%";
    overlay.height = "100%";
    overlay.background = "rgba(40, 10, 10, 0.8)";
    overlay.thickness = 0;
    uiManager.addControl(overlay);

    const panel = createStyledPanel("500px", "300px");
    uiManager.addControl(panel);

    const stack = new BABYLON.GUI.StackPanel();
    panel.addControl(stack);

    const loseText = new BABYLON.GUI.TextBlock();
    loseText.text = "DEFEAT";
    loseText.color = "#ff4d4d";
    loseText.fontSize = 72;
    loseText.fontFamily = UI_STYLES.fontFamily;
    loseText.fontWeight = "bold";
    loseText.height = "100px";
    stack.addControl(loseText);

    const subText = new BABYLON.GUI.TextBlock();
    subText.text = "The arena claimed you this time.";
    subText.color = UI_STYLES.colors.secondary;
    subText.fontSize = 20;
    subText.fontFamily = UI_STYLES.fontFamily;
    subText.height = "40px";
    stack.addControl(subText);

    const restartButton = BABYLON.GUI.Button.CreateSimpleButton("restartButton", "TRY AGAIN");
    restartButton.width = "200px";
    restartButton.height = "60px";
    restartButton.color = "white";
    restartButton.background = "#6a2d2d";
    restartButton.cornerRadius = 15;
    restartButton.thickness = 0;
    restartButton.fontSize = 24;
    restartButton.fontFamily = UI_STYLES.fontFamily;
    restartButton.fontWeight = "bold";
    restartButton.top = "20px";
    restartButton.onPointerUpObservable.add(() => {
        location.reload();
    });
    stack.addControl(restartButton);
}

createScene().then((scene) => {
    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener("resize", () => engine.resize());
});