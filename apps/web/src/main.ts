import { ElButton } from 'element-plus/es/components/button/index'
import 'element-plus/es/components/button/style/css'
import {
  ElCheckbox,
  ElCheckboxGroup,
} from 'element-plus/es/components/checkbox/index'
import 'element-plus/es/components/checkbox/style/css'
import 'element-plus/es/components/checkbox-group/style/css'
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import './style.css'

const app = createApp(App)

app.use(ElButton)
app.use(ElCheckbox)
app.use(ElCheckboxGroup)
app.use(i18n)
app.mount('#app')
