import { onRequest as __api_livescore_js_onRequest } from "C:\\Users\\Toni\\Desktop\\BET\\AH_Python_tool\\AH_Python_tool\\webapp\\HalvestAH\\functions\\api\\livescore.js"
import { onRequest as __api_scrape_js_onRequest } from "C:\\Users\\Toni\\Desktop\\BET\\AH_Python_tool\\AH_Python_tool\\webapp\\HalvestAH\\functions\\api\\scrape.js"

export const routes = [
    {
      routePath: "/api/livescore",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_livescore_js_onRequest],
    },
  {
      routePath: "/api/scrape",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_scrape_js_onRequest],
    },
  ]