/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

// process.env.DEBUG='pw:api'

const { firefox } = require('playwright-firefox');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const knox = require('knox')
const d3 = require('d3-dsv')

const filePathImages = 'zoo-cams/stills'
const filePathGIF = 'zoo-cams/output'
const frameCount = 15
const frameRange = [...Array(frameCount).keys()]



const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

const client = knox.createClient({
	key: AWS_KEY,
	secret: AWS_KEY_SECRET,
	bucket: AWS_BUCKET
})

const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))

async function makeZoo(cam){
	// these variables need to remain unique for each video
	let allScreenshots = []
	let videoDimensions = {
		width: 0,
		height: 0
	}

	// launch browser
	const browser = await firefox.launch({headless: true,  args: ['--no-sandbox']}).catch(e => console.error(`error launching browser: ${e}`))
	
	async function createGif(algorithm) {
		const {id} = cam
		return new Promise(async (resolve1, reject) => {
		//  there will always be the same range of image number files
		// so just iterate and create an array of numbers
			console.log(`Creating ${id} gif`)
  
			const [width, height] = await new Promise((resolve2) => {

			// get the file and metadata from s3 without loading it
				client.getFile(`${filePathImages}/${id}.png`, (err, res) => {
					resolve2([res.headers['x-amz-meta-width'], res.headers['x-amz-meta-height']])
				})

			}).catch(e => console.error(e))

			const canvasWidth = 500
			const canvasHeight = 281
		
  
			const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)
	
			const canvas = createCanvas(canvasWidth, canvasHeight)
			const ctx = canvas.getContext('2d')
			encoder.start()
			encoder.setDelay(200)

			async function processImage(file){
				await new Promise((resolveProc, rejectProc) => {
					const image = new Image()

					image.onload = () => {
						ctx.drawImage(image, 0, 0, width, height, // source dimensions
							0, 0, canvasWidth, canvasHeight)

						ctx.getImageData(0, 0, width, height)
					

						encoder.addFrame(ctx)
						resolveProc()
				
					}

					image.onerror = () => {
						console.log('load error')
						rejectProc()
					}
					image.src = `data:image/png;base64,${file.str}`

				}).catch((e) => console.error(e))
			}


		  async function orderImages(){

				// only process is 15 screenshots were actually taken
				if (allScreenshots.length === frameCount){
					for (const file of allScreenshots){
						await processImage(file)
			  }

					encoder.finish()
					const buffer = encoder.out.getData()

					const req = client.put(`${filePathGIF}/${id}.gif`, {
						'Content-Type': 'image/gif',
					})

					req.on('response', (res) => {
						if (res.statusCode === 200){
							console.log('saved to %s', req.url)
							resolve1()
							allScreenshots = []
						} else {
							console.log(`Status: ${res.statusCode}`)
							reject()
						}
					})

					req.on('error', e => console.error(e))

					req.end(buffer)
				}
			  
		  }

		  await orderImages()
		
		})
	
	}


	// async function collectData(){
	// 	const timestamp = Date.now()
	// 	cam.timestamp = timestamp

	// 	const string = JSON.stringify(cam)

	// 	data.push(string)
	// }

	function timeout(ms){
		return new Promise(resolve => setTimeout(resolve, ms)).catch(e => console.error(e))
	}


	async function sendToS3(ss){

		const {id} = cam

		return new Promise((resolve, reject) => {
		// write screenshot to AWS
			const req = client.put(`${filePathImages}/${id}.png`, {
				'Content-Type': 'image/png',
				'x-amz-meta-height': videoDimensions.height,
				'x-amz-meta-width': videoDimensions.width
			})

			req.on('response', (res) => {
				if (res.statusCode === 200){
					console.log('saved to %s', req.url)
					resolve(res)
			
					return res.statusCode
				} return null
			})

			req.on('error', e => console.error(e))

			req.end(ss)
		})

	
	}

	async function takeScreenshots(element){
		await new Promise(async (resolveSS) => {
			const {id} = cam			
			
			// save only the first image to AWS
			async function saveFirst(ss){
				videoDimensions =  await element.evaluate(() => ({
					width: document.documentElement.clientWidth,
					height: document.documentElement.clientHeight
				})).catch(e => console.error(`save first error: ${e}`))

				await sendToS3(ss)
			}
			// eslint-disable-next-line no-restricted-syntax
			for (const frame of frameRange){
	
				// eslint-disable-next-line no-await-in-loop
				const ss = await element.screenshot({path: ''}).catch((e) => {
					console.error(`error in playwright screenshot: ${e}`); 
					return('') })

				const str = ss.toString('base64')


				// save all ss data locally 
				allScreenshots.push({index: frame, str, ss, id})

				// run function to just save first image
				// all others are still saved locally
				if (frame === 0){
					await saveFirst(ss)
				}
			}
 
			// then resolve this promise to continue to gif-making
			resolveSS()

		}).catch((e) => console.error(`take screenshots error: ${e}`))
	
	}


	async function screenshot(page) {

		let element = null

		try {

			// set a timeout for the page of 10 seconds
			page.setDefaultTimeout(15000)

			const {url, id, play} = cam
			console.log(`Preparing ${id} for screenshot`)

			// navigate to URL
			await page.goto(url).catch((e) => {console.error(`error navigating to page: ${e}`)})
			// await page.waitForLoadState({ waitUntil: 'domcontentloaded' }).catch((e) => {console.error(e)})

			// const full = await page.screenshot()
			// await sendToS3(full)

			// if there's a play button, click it
			if (play) {
				const buttons = play.split(', ')
				buttons.forEach(async d => {
					await page.click(`${d}`).catch((e) => console.error(`error looking for play buttons: ${e}`))
				})
			}


			// wait for video
			await page.waitForSelector('video').catch((e) => {console.error(`error waiting for video: ${e}`)})

			element = await page.$('video').catch((e) => {console.error(`error creating element: ${e}`)})

			if (element){
				// after video has loaded, then record data
				// await collectData(cam) 
		
				await timeout(5000)

				page.on('console', async message => {
					console.log({message})
				})
				
				await page.$eval('video', el => el.play()).catch(e => console.error(`error playing video: ${e}`))
				await page.waitForTimeout(5000)
				await takeScreenshots(element)

				
			}
	
		} catch (err) {
			console.log(`Error in screenshot function: ${err}`)
		}

		
	
	}


	async function getZoos(){
		// await loopThroughCams(sample)
		// launch a single page 
		const page = await browser.newPage().catch(e => console.error(`error launching new page: ${e}`))
		await screenshot(page)
		// close browser after screenshots are taken
		await browser.close()
		// await takeScreenshots(vidElement)
		if (allScreenshots.length > 0){
			await createGif('neuquant')
		}
		
	}

	await getZoos()
}


async function runBatches(){
	// run the script in batches

	try {
		for (let i = 0; i < 5; i += 1){
			
			const finished = webcams.slice(i, i + 1).map(async cam =>  makeZoo(cam))

			await Promise.all(finished).catch(e => console.log(`Error in getting videos for batch ${i} - ${e}`))
		
		}	
	}
	catch (err){
		console.error(err)
	}
	
}


runBatches()