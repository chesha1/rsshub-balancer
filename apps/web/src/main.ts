import { ElButton } from 'element-plus/es/components/button/index'
import 'element-plus/es/components/button/style/css'
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import './style.css'

const app = createApp(App)

app.use(ElButton)
app.use(i18n)
app.mount('#app')
