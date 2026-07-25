const CLOUD_URL = "http://127.0.0.1:3000";
const TOKEN =
  "382ac7ebf58c8fc0ac8d5a26c534e61bbe49681cb359b7e9bcb36b346e18f336";

// SET SESSIONS
exports.set_session = async () => {
  try {
    console.log("Setting Up Session");
    const res = await fetch(CLOUD_URL + "/notebook/proxy/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // important for session
      body: JSON.stringify({
        migid: "Mig-2",
        requestId: "6a639a430729040d619d58ba",
      }),
    });

    // READ THE COOKIE
    const setCookie = res.headers.get("set-cookie");

    if (setCookie) {
      // Keep only the actual cookie(s), remove attributes
      const cookieHeader = setCookie
        .split(/,(?=\s*\w+=)/) // handles multiple cookies
        .map((cookie) => cookie.split(";")[0])
        .join("; ");

      //   console.log("Cookie header:", cookieHeader);

      // Save globally
      global.sessionCookie = cookieHeader;
    }

    const data = await res.json();

    if (res.ok) {
      console.log("Session Setup OK");
      // TO DO
    } else {
      console.log(data.message || "Failed to initialize session");
    }
  } catch (err) {
    console.error(err);
  }
};

// GET VERSION OF THE APP
exports.get_version = async () => {
  try {
    const res = await fetch(CLOUD_URL + "/notebook/api/", {
      method: "GET",
      headers: {
        Cookie: global.sessionCookie,
        Authorization: `token ${TOKEN}`,
      },
    });

    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await res.json();
      console.log("Application Version:", data.version);
    }
  } catch (err) {
    console.error("Request failed:", err);
  }
};

// GET ALL DIRECTORY CONTENT
exports.get_notebook_contents = async (path = "") => {
  try {
    const res = await fetch(CLOUD_URL + "/notebook/api/contents/" + path, {
      method: "GET",
      headers: {
        Cookie: global.sessionCookie,
        Authorization: `token ${TOKEN}`,
      },
    });

    const content_type = res.headers.get("content-type");

    if (content_type?.includes("application/json")) {
      const data = await res.json();
      return data;
    }
  } catch (err) {
    console.error("Error fetching contents:", err);
  }
};

// CREATE NEW FOLDER
exports.createFolder = async (parent, name) => {
  const body = {
    type: "directory",
    path: parent ? `${parent}/${name}/` : name,
  };

  console.log("Create Folder : ", body.path);
  const res = await fetch(CLOUD_URL + "/notebook/api/contents/" + parent, {
    method: "POST",
    headers: {
      Cookie: global.sessionCookie,
      Authorization: `token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  console.log(data);
};

// CREATE NEW FILE
exports.createFile = async (parent, name) => {
  await fetch(CLOUD_URL + "/notebook/api/contents/" + parent, {
    method: "POST",
    headers: {
      Cookie: global.sessionCookie,
      Authorization: `token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "file",
      format: "text",
      content: "",
      path: `${parent}/${name}`,
    }),
  });
};
